import type { NextConfig } from "next";

// Deployed under ignura.com/astrahack (NEXT_PUBLIC_BASE_PATH=/astrahack on Vercel); empty locally.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  // `next dev` rewrites the tracked canvas/CLAUDE.md on every start, which dirties the tree and blocks `git pull --rebase`.
  agentRules: false,
};

export default nextConfig;
