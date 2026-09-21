import { useEffect, useState } from "react";

/**
 * Returns `value` delayed by `delayMs`. The corpus filter inputs drive a
 * react-query fetch on every change; some archive endpoints (notably
 * /api/documents over ~50k court documents) are slow, so keying the query on a
 * debounced value means rapid typing issues one request once typing settles,
 * not one per keystroke. The input stays bound to the immediate value, so the
 * field itself remains fully responsive.
 */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
