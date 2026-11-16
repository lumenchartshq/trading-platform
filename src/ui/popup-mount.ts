import { createContext } from "solid-js";
/** Popups escape dock clipping through a presentation-owned surface, isolated per mounted UI. */
export const TradingPopupMount = createContext<HTMLElement>();
/** Inside a modal dialog, popups must render within the dialog or the modal blocks their pointer events. */
export const TradingDialogPopupMount = createContext<() => HTMLElement | undefined>();
