export function WebWelcomeStep() {
  return (
    <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
      <div className="flex items-center gap-4">
        <img
          src="/uno-mark.svg"
          alt="Uno Work"
          className="size-20 rounded-2xl shadow-lg shadow-primary/20"
        />
        <span className="text-4xl font-bold tracking-tight">Work</span>
      </div>
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
        A real machine, in your browser
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
        No install. This tab is connected to a Linux machine that is yours — with a terminal, a
        filesystem, git, and an AI agent that works on the files stored there.
      </p>
      <p className="text-xs text-muted-foreground/70">
        Takes about a minute · You can skip any step
      </p>
    </div>
  );
}
