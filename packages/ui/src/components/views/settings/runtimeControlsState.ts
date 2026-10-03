export const RELOAD_PI_LABEL = 'Reload Pi';
export const RESTART_PICHAMBER_LABEL = 'Restart PiChamber';

export type RuntimeControlsState = { reloading: boolean; restarting: boolean; confirmOpen: boolean };
export type RuntimeControlsAction =
  | { type: 'reload-started' }
  | { type: 'reload-finished' }
  | { type: 'restart-requested' }
  | { type: 'restart-cancelled' }
  | { type: 'restart-confirmed' }
  | { type: 'restart-finished' };

export const initialRuntimeControlsState: RuntimeControlsState = { reloading: false, restarting: false, confirmOpen: false };

/** Restart never starts from the button alone: it opens the confirmation, and only a confirm starts it. */
export const runtimeControlsReducer = (state: RuntimeControlsState, action: RuntimeControlsAction): RuntimeControlsState => {
  switch (action.type) {
    case 'reload-started': return { ...state, reloading: true };
    case 'reload-finished': return { ...state, reloading: false };
    case 'restart-requested': return state.restarting ? state : { ...state, confirmOpen: true };
    case 'restart-cancelled': return { ...state, confirmOpen: false };
    case 'restart-confirmed': return { ...state, confirmOpen: false, restarting: true };
    case 'restart-finished': return { ...state, restarting: false };
  }
};
