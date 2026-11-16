import { createContext } from "solid-js";
import type { TicketPlacement, TicketPlacementState } from "./placement.js";
export interface TicketLayoutControls {
  readonly placement: TicketPlacement;
  readonly canMove: () => boolean;
  readonly state: () => Readonly<TicketPlacementState>;
}
export const TicketLayoutContext = createContext<TicketLayoutControls>();
