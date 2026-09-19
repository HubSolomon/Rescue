"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary with a working retry. Without this, a failed
 * server fetch shows Next's default page and the user's only option is a
 * manual reload.
 */
export default function LocaleError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="layout">
      <div className="shell narrow">
        <div className="state state-error" role="alert">
          <h3>Etwas ist schiefgelaufen / Something went wrong</h3>
          <p>Die Daten konnten nicht geladen werden. / The data could not be loaded.</p>
          <button className="button" onClick={reset}>
            Erneut versuchen / Try again
          </button>
        </div>
      </div>
    </div>
  );
}
