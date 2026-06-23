import Container from "./container";

export default async function Header() {
  return (
    <nav className="w-full py-4 md:py-6">
      <Container className="flex flex-wrap justify-between items-end gap-x-8 gap-y-4">
        <div className="flex items-center gap-3">
          <a href="/" className="text-xl font-bold text-purple no-underline">
            herzies
            <span className="text-[10px] font-medium opacity-60 ml-1">
              [open beta]
            </span>
          </a>
        </div>

        <div className="flex gap-4 items-center">
          <a href="/leaderboard" className="text-[13px] text-yellow">
            leaderboard
          </a>
        </div>
      </Container>
    </nav>
  );
}
