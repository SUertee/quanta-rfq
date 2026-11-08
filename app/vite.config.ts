import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
 const env = loadEnv(mode, process.cwd(), '');
 const llmBase = env.RFQ_LLM_BASE_URL || 'https://token.moi.matrixorigin.cn/v1';
 return {
  base: env.RFQ_BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 5176,
    host: '127.0.0.1',
    strictPort: true,
    // Backend persistence and test bundles must not reload an in-progress browser workflow.
    watch: {ignored:['**/server/**','**/scripts/**','**/*.tsbuildinfo']},
    proxy: {
      // 规避浏览器 CORS：/llm/* → MOI Genesis /v1/*（仅开发环境；生产由后端代理）
      '/llm': {
        target: llmBase,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/llm/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            if (env.RFQ_LLM_API_KEY) request.setHeader('Authorization', `Bearer ${env.RFQ_LLM_API_KEY}`);
          });
        },
      },
      // /hy/* → 混元 OpenAI 兼容端点
      '/hy': {
        target: 'https://api.hunyuan.cloud.tencent.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/hy/, '/v1'),
      },
      // /th/* → 腾讯 TokenHub（备用，key 若属 TokenHub 可改 baseUrl 为此）
      '/th': {
        target: 'https://tokenhub.tencentcloudmaas.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/th/, '/v1'),
      },
      // /wsa/* → 元宝搜索 WSA（SearchPro）
      '/wsa': {
        target: 'https://api.wsa.cloud.tencent.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/wsa/, ''),
      },
      // /api/* → 库存后端（Node + SQLite，端口 3001）
      '/api': {
        target: 'http://127.0.0.1:3004',
        changeOrigin: true,
      },
      // /oxr/* → OXR 文档解析（SoMark 免费 API，扫描件/表格）
      '/oxr': {
        target: 'https://free-oxr.somark.cn',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/oxr/, '/api/v1'),
      },
    },
  },
};
});
