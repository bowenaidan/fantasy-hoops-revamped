import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the project root so a stray package-lock.json in a parent directory
  // (e.g. the home folder) isn't mistaken for the workspace root.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
