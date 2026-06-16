"""AI Visor Python 사이드카 — 로컬 HTTP 서버 (기획서 §8, 원칙 5).

Electron 메인이 자유 포트와 임의 토큰을 인자로 넘겨 이 서버를 spawn한다.
- 127.0.0.1 에만 바인딩한다(로컬 전용 — 외부 노출 없음).
- 모든 요청은 X-Sidecar-Token 헤더로 인증한다(같은 머신의 다른 프로세스가
  임의 파일 경로로 호출하는 것을 차단).
- 표준출력/표준에러는 메인이 로그 파일로 리다이렉트한다.

라우트:
  GET  /health  → {"ok": true, "pptx": bool}        준비·의존성 확인용
  POST /extract → {"sourceName", "slides":[...], "renderStatus", "renderMessage"}

slides[i] = {"number","title","bodyText","speakerNotes","imageDataUrl": str|null}
imageDataUrl 은 'data:image/png;base64,...' 또는 null(이미지 없음 → 텍스트로).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from document_parser import UnsupportedDocument, extract_document
from slide_renderer import render_slides

# 메인 → 사이드카 인증 토큰. start 시 인자로 주입된다(매 실행 새로 발급).
_AUTH_TOKEN = ""

# 파싱 전에 거부할 파일 크기 상한 — 거대 파일이 메모리를 삼키는 것을 막는다(심층 방어).
# 압축 폭탄(작은 압축 → 거대 해제)은 이걸로 못 막으나, 추출 텍스트는 document_parser의
# 구획·문자 상한이 따로 묶는다.
MAX_DOCUMENT_BYTES = 200 * 1024 * 1024


def _png_to_data_url(png_path):
    if png_path is None or not os.path.exists(png_path):
        return None
    try:
        with open(png_path, "rb") as png_file:
            encoded = base64.b64encode(png_file.read()).decode("ascii")
        return "data:image/png;base64," + encoded
    except OSError:
        return None


def _has_pptx() -> bool:
    try:
        import pptx  # noqa: F401
        return True
    except ImportError:
        return False


class SidecarHandler(BaseHTTPRequestHandler):
    # 기본 로깅을 끈다 — 출력은 메인이 로그 파일로 관리한다(버퍼 행 방지)
    def log_message(self, *args):
        return

    def _authorized(self) -> bool:
        return self.headers.get("X-Sidecar-Token") == _AUTH_TOKEN

    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._send_json(403, {"error": "forbidden"})
            return
        self._send_json(200, {"ok": True, "pptx": _has_pptx()})

    def do_POST(self) -> None:
        if self.path != "/extract":
            self._send_json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._send_json(403, {"error": "forbidden"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            request = json.loads(raw_body or b"{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "요청 본문이 JSON이 아닙니다."})
            return

        # 'path'(범용) 우선, 'pptxPath'(구버전 키)도 받아 호환
        doc_path = request.get("path") or request.get("pptxPath")
        want_render = bool(request.get("render", True))
        # 정규 파일만 — 디렉터리(확장자 위장 폴더 등)는 거부한다(심층 방어, isfile은 디렉터리에 False)
        if not isinstance(doc_path, str) or not os.path.isabs(doc_path) or not os.path.isfile(doc_path):
            self._send_json(400, {"error": "잘못되거나 존재하지 않는 문서 경로입니다."})
            return
        # 메인이 이미 막지만 사이드카도 심볼릭 링크를 거부한다(TOCTOU·직접 호출 대비)
        if os.path.islink(doc_path):
            self._send_json(400, {"error": "심볼릭 링크는 허용되지 않습니다."})
            return
        # 과도하게 큰 파일은 파싱 전에 거부한다(메모리 폭주 방지)
        if os.path.getsize(doc_path) > MAX_DOCUMENT_BYTES:
            self._send_json(413, {"error": "문서가 너무 커요(최대 %dMB)." % (MAX_DOCUMENT_BYTES // (1024 * 1024))})
            return

        try:
            extracted = extract_document(doc_path)
        except UnsupportedDocument as error:  # 미지원 형식·의존성 누락 — 사유를 그대로 안내
            self._send_json(415, {"error": str(error)})
            return
        except Exception as error:  # 파서별 다양한 예외를 한데 흡수(부분 실패는 크래시 금지)
            self._send_json(500, {"error": "문서 파싱에 실패했습니다: %s" % error})
            return

        doc_type = extracted["docType"]
        slides = extracted["sections"]

        render_status = "skipped"
        render_message = None
        out_dir = None
        try:
            # 슬라이드 이미지는 PPTX만 — 그 외 타입은 텍스트로 표시(이미지 변환 대상 아님)
            if want_render and doc_type == "pptx" and slides:
                out_dir = tempfile.mkdtemp(prefix="aivisor-slides-")
                render = render_slides(doc_path, out_dir, len(slides))
                render_status = render["status"]
                render_message = render["message"]
                images = render["images"]
                for index, slide in enumerate(slides):
                    png_path = images[index] if index < len(images) else None
                    slide["imageDataUrl"] = _png_to_data_url(png_path)
            else:
                for slide in slides:
                    slide["imageDataUrl"] = None
        finally:
            # PNG는 data URL로 이미 인코딩됐으므로 임시 파일을 즉시 정리한다(잔재 방지)
            if out_dir is not None:
                shutil.rmtree(out_dir, ignore_errors=True)

        self._send_json(
            200,
            {
                "sourceName": os.path.basename(doc_path),
                "docType": doc_type,
                "slides": slides,
                "renderStatus": render_status,
                "renderMessage": render_message,
            },
        )


def main() -> int:
    global _AUTH_TOKEN
    parser = argparse.ArgumentParser(description="AI Visor Python sidecar")
    parser.add_argument("--port", type=int, required=True, help="바인딩할 로컬 포트(메인이 지정)")
    parser.add_argument("--token", type=str, required=True, help="요청 인증 토큰(메인이 발급)")
    args = parser.parse_args()
    _AUTH_TOKEN = args.token

    # 127.0.0.1 전용 바인딩 — 외부 노출 금지. 포트가 점유 중이면 즉시 실패(메인이 감지)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), SidecarHandler)
    print("[sidecar] listening on 127.0.0.1:%d" % args.port, file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
