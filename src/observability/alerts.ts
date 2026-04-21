export class AlertSink {
  private readonly alerts: string[] = [];

  push(message: string): void {
    this.alerts.push(message);
  }

  list(): string[] {
    return [...this.alerts];
  }
}
