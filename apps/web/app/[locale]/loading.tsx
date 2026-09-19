export default function LocaleLoading() {
  return (
    <div className="layout">
      <div className="shell">
        <div className="skeleton-group" role="status" aria-busy="true">
          <span className="sr-only">Wird geladen …</span>
          <div className="skeleton skeleton-title" aria-hidden="true" />
          <div className="skeleton" aria-hidden="true" />
          <div className="skeleton" aria-hidden="true" />
          <div className="skeleton" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
