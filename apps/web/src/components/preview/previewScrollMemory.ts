const scrollPositions = new Map<string, number>();

export function getScrollPosition(id: string): number | undefined {
  return scrollPositions.get(id);
}

export function setScrollPosition(id: string, value: number): void {
  scrollPositions.set(id, value);
}

export function forgetScrollPosition(id: string): void {
  scrollPositions.delete(id);
}
