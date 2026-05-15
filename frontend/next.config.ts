import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // PDFs de edital chegam tranquilamente a 30-60MB. Bucket Storage permite 100MB.
      bodySizeLimit: '110mb',
    },
  },
  // Permite que o app seja acessado via túnel cloudflared (URL aleatória)
  // e outras origens em dev. Em produção, fixar pro domínio real.
  allowedDevOrigins: [
    '*.trycloudflare.com',
    'localhost',
    '127.0.0.1',
    '192.168.0.0/16',
  ],
};

export default nextConfig;
