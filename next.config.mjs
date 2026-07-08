/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Ensure the scripts/*.sql migration files are bundled into the serverless
  // output so lib/db.ts can read + auto-apply them at runtime on Vercel.
  outputFileTracingIncludes: {
    "/**": ["./scripts/**/*.sql"],
  },
}

export default nextConfig
