import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // PDFs de edital chegam tranquilamente a 30-60MB. Bucket Storage permite 100MB.
      bodySizeLimit: '110mb',
    },
  },
};

export default nextConfig;
