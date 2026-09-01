const SUGGESTIONS = [
  "I'm hiking in Iceland in October, need something waterproof and lightweight under €250",
  "Something warm to sleep in while winter camping",
  "I need to cook a quick meal on the trail",
  "Lightweight gear for a day hike in the mountains",
  "Something to keep my phone charged while backpacking",
  "Comfortable shoes for walking around the city",
];

interface SuggestionChipsProps {
  onSelect: (suggestion: string) => void;
}

export function SuggestionChips({ onSelect }: SuggestionChipsProps) {
  return (
    <div className="suggestions">
      <p>Try one of these:</p>
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          type="button"
          className="chip"
          onClick={() => onSelect(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
