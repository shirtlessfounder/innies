import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

export default function nextConfig(phase) {
  const isDevServer = phase === PHASE_DEVELOPMENT_SERVER;

  return {
    reactStrictMode: true,
    distDir: isDevServer ? '.next-dev' : '.next',
    webpack(config) {
      if (isDevServer) {
        // Avoid filesystem cache churn between rebuilds in local dev.
        config.cache = false;
      }

      return config;
    }
  };
}
