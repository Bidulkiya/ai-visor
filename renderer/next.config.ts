import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Electron이 빌드 결과(out/)를 자체 스킴으로 서빙한다 — 정적 export 고정
  output: 'export',
  // 정적 export에서는 이미지 최적화 서버가 없다
  images: { unoptimized: true },
  webpack: (config, { webpack }) => {
    // Anthropic SDK가 Node 전용 모듈(node:fs 등)을 정적 import한다 —
    // 브라우저(렌더러) 경로에서는 실행되지 않으므로 번들에서 빈 모듈로 대체한다.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
        resource.request = resource.request.replace(/^node:/, '')
      }),
    )
    config.resolve = config.resolve ?? {}
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      os: false,
      crypto: false,
    }
    return config
  },
}

export default nextConfig
