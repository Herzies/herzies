import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// scripts/local.sh builds into its own folder: NEXT_PUBLIC_* values are
	// baked into the client bundle, so sharing .next with a prod-backed dev
	// server would hand the browser whichever stack built first.
	distDir: process.env.NEXT_DIST_DIR || ".next",
	transpilePackages: ["@herzies/shared"],
	async headers() {
		return [
			{
				source: "/(.*)",
				headers: [
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
					{
						key: "Strict-Transport-Security",
						value: "max-age=63072000; includeSubDomains; preload",
					},
					{
						key: "Permissions-Policy",
						value: "camera=(), microphone=(), geolocation=()",
					},
				],
			},
		];
	},
};

export default nextConfig;
