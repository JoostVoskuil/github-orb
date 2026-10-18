interface Window {
  renderAtlas: (options: { mood: string; frames: number; fps: number; columns: number }) => string;
  renderPoster: (mood?: string, time?: number) => string;
  rendererSettings: any;
  rendererReady: boolean;
  orbAtlases: Record<string, ImageBitmap>;
}