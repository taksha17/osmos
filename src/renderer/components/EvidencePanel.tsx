type Props = {
  usedWebSearch: boolean;
  searchHits: number;
  documentCount: number;
  usedRetrieval?: boolean;
};

export function EvidencePanel({ usedWebSearch, searchHits, documentCount, usedRetrieval }: Props) {
  const items = [
    usedWebSearch ? { label: 'Web search', detail: `${searchHits} hits` } : null,
    documentCount > 0 ? { label: 'Documents', detail: `${documentCount} attached` } : null,
    usedRetrieval ? { label: 'Retrieval', detail: 'semantic chunks' } : null,
  ].filter(Boolean) as Array<{ label: string; detail: string }>;

  if (items.length === 0) return null;

  return (
    <div className="evidence-panel">
      {items.map((item) => (
        <span key={item.label} className="evidence-chip">
          <strong>{item.label}</strong>: {item.detail}
        </span>
      ))}
    </div>
  );
}
