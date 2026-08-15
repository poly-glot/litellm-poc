export interface RegionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
