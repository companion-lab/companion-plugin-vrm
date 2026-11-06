// Types for the vendored react-dom compat shim (see react-dom-compat.js).
// Matches the createPortal signature of react-dom (React 18/19 types).

import type { ReactNode, ReactPortal } from "react";

export function createPortal(
  children: ReactNode,
  container: Element | DocumentFragment,
  key?: string | null,
): ReactPortal;
