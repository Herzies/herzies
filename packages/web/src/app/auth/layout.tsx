import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <style>{`
				body > nav, body > footer { display: none !important; }
			`}</style>
      <div className="min-h-screen flex items-center justify-center">
        {children}
      </div>
    </>
  );
}
