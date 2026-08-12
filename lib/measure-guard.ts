/**
 * Serializes async runs against overlapping triggers: while a run is in
 * flight, further triggers coalesce into one queued re-run that starts with
 * the newest inputs when the in-flight run finishes. Keeps a slow caption
 * fetch from landing after a newer measure and rendering a stale pill.
 * Shared by entrypoints/content.ts and entrypoints/generic.content.ts.
 */
export class SerializedRunner {
  private running = false;
  private queued = false;

  run(fn: () => Promise<void>): void {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    void fn().finally(() => {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        this.run(fn);
      }
    });
  }
}
