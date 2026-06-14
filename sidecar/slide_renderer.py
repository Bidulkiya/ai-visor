"""슬라이드 이미지 변환 — LibreOffice 헤드리스(PPTX→PDF) + PyMuPDF(PDF→PNG).

설계 원칙:
- LibreOffice 또는 PyMuPDF가 없으면 **크래시하지 않는다**. 명확한 사유를 담아
  이미지 없는 결과를 돌려주고, 호출자는 텍스트만으로 발표를 이어간다.
- **자동 설치는 절대 시도하지 않는다**(사용자 환경 존중).
- 개별 슬라이드 변환이 실패하면 그 슬라이드만 이미지 None — 발표는 중단되지 않는다.

python-pptx로는 슬라이드 이미지화가 불가하므로(알려진 한계) LibreOffice로
PPTX→PDF를 만든 뒤 PDF의 각 페이지를 PNG로 렌더링한다.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
from pathlib import Path

# LibreOffice 변환 타임아웃 — 멈춰도 발표 준비가 행(hang)에 걸리지 않게
PDF_CONVERT_TIMEOUT_SEC = 90
# 렌더 해상도 — 발표 패널 표시에 충분하되 과하지 않게(72 = PDF 기본)
RENDER_DPI = 130

# 렌더 결과 상태 — 호출자가 사용자 안내 문구를 고를 수 있게 구분한다
STATUS_OK = "ok"
STATUS_LIBREOFFICE_MISSING = "libreoffice-missing"
STATUS_RENDERER_MISSING = "renderer-missing"
STATUS_RENDER_FAILED = "render-failed"

_SOFFICE_CANDIDATES = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/opt/libreoffice/program/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
]


def find_soffice():
    """LibreOffice 실행 파일을 찾는다. 없으면 None(텍스트 폴백 신호)."""
    on_path = shutil.which("soffice")
    if on_path:
        return on_path
    for candidate in _SOFFICE_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    return None


def _result(status: str, message, images: list) -> dict:
    return {"status": status, "message": message, "images": images}


def _terminate_process_tree(process: subprocess.Popen) -> None:
    """프로세스와 그 자식(soffice.exe→soffice.bin 등)을 통째로 종료한다.

    LibreOffice는 런처 프로세스가 별도 워커 프로세스를 띄우므로, 런처만 죽이면
    워커가 고아로 남는다(CLAUDE.md §5 좀비 방지). 트리 전체를 종료한다.
    """
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass


def _run_soffice(args) -> int:
    """LibreOffice를 새 프로세스 그룹으로 실행하고, 타임아웃이면 트리째 죽인다."""
    popen_kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs["start_new_session"] = True

    process = subprocess.Popen(args, **popen_kwargs)
    try:
        process.communicate(timeout=PDF_CONVERT_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        # 멈춘 LibreOffice 트리를 정리한 뒤 타임아웃을 그대로 전파(호출자가 폴백)
        _terminate_process_tree(process)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        raise
    if process.returncode != 0:
        raise subprocess.CalledProcessError(process.returncode, args)
    return process.returncode


def _convert_to_pdf(soffice: str, pptx_path: str, out_dir: str):
    """LibreOffice 헤드리스로 PPTX→PDF. 성공 시 PDF 경로, 실패 시 None."""
    # 호출마다 독립 프로필을 쓰게 해 동시 실행·잔류 잠금 충돌을 피한다
    profile_uri = Path(os.path.join(out_dir, "lo-profile")).as_uri()
    args = [
        soffice,
        "--headless",
        "--norestore",
        "--invisible",
        "-env:UserInstallation=" + profile_uri,
        "--convert-to",
        "pdf",
        "--outdir",
        out_dir,
        pptx_path,
    ]
    _run_soffice(args)
    base_name = os.path.splitext(os.path.basename(pptx_path))[0]
    pdf_path = os.path.join(out_dir, base_name + ".pdf")
    return pdf_path if os.path.exists(pdf_path) else None


def _pdf_to_pngs(pdf_path: str, out_dir: str):
    """PDF의 각 페이지를 PNG로 렌더링한다. PyMuPDF가 없으면 None(렌더러 없음 신호)."""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return None

    png_paths = []
    zoom = RENDER_DPI / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    document = fitz.open(pdf_path)
    try:
        for index in range(document.page_count):
            try:
                page = document.load_page(index)
                pixmap = page.get_pixmap(matrix=matrix)
                png_path = os.path.join(out_dir, "slide-%d.png" % (index + 1))
                pixmap.save(png_path)
                png_paths.append(png_path)
            except Exception:
                # 개별 페이지 실패는 그 슬라이드만 이미지 없음 — 전체 중단 없음
                png_paths.append(None)
    finally:
        document.close()
    return png_paths


def render_slides(pptx_path: str, out_dir: str, slide_count: int) -> dict:
    """슬라이드별 PNG 경로 목록을 만든다.

    반환: {"status", "message", "images": [png_path|None, ...]} (길이 = slide_count).
    어떤 실패도 예외로 전파하지 않는다 — 호출자는 images의 None을 텍스트로 처리한다.
    """
    empty = [None] * slide_count

    soffice = find_soffice()
    if soffice is None:
        return _result(
            STATUS_LIBREOFFICE_MISSING,
            "LibreOffice가 설치돼 있지 않아 슬라이드 이미지를 만들지 못했습니다. 텍스트로 발표를 진행합니다.",
            empty,
        )

    try:
        pdf_path = _convert_to_pdf(soffice, pptx_path, out_dir)
    except subprocess.TimeoutExpired:
        return _result(STATUS_RENDER_FAILED, "슬라이드 이미지 변환이 시간 내에 끝나지 않았습니다. 텍스트로 진행합니다.", empty)
    except (subprocess.CalledProcessError, OSError) as error:
        return _result(STATUS_RENDER_FAILED, "슬라이드 이미지 변환에 실패했습니다(%s). 텍스트로 진행합니다." % error, empty)

    if pdf_path is None:
        return _result(STATUS_RENDER_FAILED, "슬라이드 이미지 변환 결과를 찾지 못했습니다. 텍스트로 진행합니다.", empty)

    png_paths = _pdf_to_pngs(pdf_path, out_dir)
    if png_paths is None:
        return _result(
            STATUS_RENDERER_MISSING,
            "PDF→이미지 변환기(PyMuPDF)가 없어 텍스트로 진행합니다. 'pip install pymupdf'로 설치하면 슬라이드가 이미지로 표시됩니다.",
            empty,
        )

    # 페이지 수가 슬라이드 수와 다를 수 있으니 slide_count에 맞춰 정렬한다
    images = [png_paths[index] if index < len(png_paths) else None for index in range(slide_count)]
    return _result(STATUS_OK, None, images)
