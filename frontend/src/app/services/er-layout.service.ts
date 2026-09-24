import { Injectable } from '@angular/core';

export interface ErNodePosition {
  objectName: string;
  x: number;
  y: number;
}

export interface ErLayoutState {
  zoom: number;
  positions: ErNodePosition[];
  svgWidth: number;
  svgHeight: number;
}

@Injectable({ providedIn: 'root' })
export class ErLayoutService {
  private state: ErLayoutState | null = null;

  save(state: ErLayoutState): void { this.state = { ...state, positions: state.positions.map(p => ({ ...p })) }; }
  load(): ErLayoutState | null { return this.state; }
  clear(): void { this.state = null; }
}
