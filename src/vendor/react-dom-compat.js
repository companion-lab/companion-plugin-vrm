// Host react-dom compat for the library plugin's own modal component, which
// needs createPortal (same shim the calendar plugin vendors; see
// features/calendar/src/vendor/react-dom-compat.js).
//
// The host shares only react-dom/client (createRoot/hydrateRoot); React 19
// dropped createPortal/findDOMNode from that entry. The host reconciler still
// renders portal elements though — it matches them structurally via the
// shared Symbol.for("react.portal") type — so createPortal below recreates
// exactly the element react-dom's own createPortal would produce, and the
// host renderer handles the rest.

const host = globalThis.__companion_host__;

if (!host || !host.ReactDOMClient) {
  throw new Error(
    "companion plugin runtime not present: this bundle must be activated by the companion host, not loaded directly",
  );
}

const REACT_PORTAL_TYPE = Symbol.for("react.portal");
const REACT_OPTIMISTIC_KEY = Symbol.for("react.optimistic_key");

export function createPortal(children, container, key = null) {
  if (
    !container ||
    (container.nodeType !== 1 &&
      container.nodeType !== 9 &&
      container.nodeType !== 11)
  ) {
    throw new Error("Target container is not a DOM element.");
  }
  return {
    $$typeof: REACT_PORTAL_TYPE,
    key:
      key == null
        ? null
        : key === REACT_OPTIMISTIC_KEY
          ? key
          : "" + key,
    children,
    containerInfo: container,
    implementation: null,
  };
}
