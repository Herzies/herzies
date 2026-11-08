import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// scripts/local.sh builds into its own folder: NEXT_PUBLIC_* values are
	// baked into the client bundle, so sharing .next with a prod-backed dev
	// server would hand the browser whichever stack built first.
	distDir: process.env.NEXT_DIST_DIR || ".next",
	transpilePackages: ["@herzies/shared"],
	// The item art workshop (local only: it 404s anywhere else) reads the
	// repo's files by paths built at runtime, so the tracer packs everything
	// it might reach — the build cache included, 700MB on Vercel, over the
	// function limit. Hosted it never reads them: leave them out.
	outputFileTracingExcludes: {
		"/api/admin/item-art/**": [
			".next/cache/**",
			"src/**",
			"public/**",
			"postman/**",
			"*.tsbuildinfo",
			".env*",
			"../../.git/**",
			"../../.turbo/**",
			"../../packages/*/src/**",
			"../../packages/desktop/**",
			"../../packages/shared/card-art/**",
			"../../packages/town-server/**",
			"../../supabase/**",
		],
	},
	// The old dev-only game admin now lives in the control panel.
	async redirects() {
		return [{ source: "/dev/admin", destination: "/admin", permanent: false }];
	},
	async headers() {
		return [
			// The front page's live Town (public/town, see TownBackdrop): its
			// chunks are named by their content, so they keep. The entry keeps
			// one name, so it's checked each time (a 304 when unchanged).
			{
				source: "/town/:file((?!showcase\\.js$).*)",
				headers: [
					{
						key: "Cache-Control",
						value: "public, max-age=31536000, immutable",
					},
				],
			},
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
