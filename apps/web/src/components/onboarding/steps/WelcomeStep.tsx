export function WelcomeStep() {
  return (
    <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-6 text-center">
      <div className="flex items-center gap-4">
        <img
          src="/apple-touch-icon.png"
          alt="Uno Work"
          className="size-20 rounded-2xl shadow-lg shadow-primary/20"
        />
        <span className="text-4xl font-bold tracking-tight">Work</span>
      </div>
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
        AI that works with your machine
      </h1>
      <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
        Uno Work is where AI works on <b>your</b> computer, with <b>your</b> files, under{" "}
        <b>your</b> control. Local-first, with optional remote power when you need it.
      </p>
      <p className="text-xs text-muted-foreground/70">
        Takes about a minute to set up · You can skip any step
      </p>
    </div>
  );
}
