export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Math.floor(Date.now() / 1000);
  }
}
