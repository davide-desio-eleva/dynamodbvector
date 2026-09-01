import { useState } from "react";
import { Authenticator } from "@aws-amplify/ui-react";
import { getClient } from "./client";
import { SearchBar } from "./components/SearchBar";
import { ProductCard } from "./components/ProductCard";
import { SuggestionChips } from "./components/SuggestionChips";
import { ParsedFiltersPanel } from "./components/ParsedFiltersPanel";
import { ChatView } from "./components/ChatView";
import { VoiceView } from "./components/VoiceView";
import "@aws-amplify/ui-react/styles.css";
import "./App.css";

type Product = {
  productId: string;
  name: string;
  category: string;
  description: string;
  price: number;
  available: boolean;
  score: number | null;
};

type ParsedFilters = {
  semanticQuery: string;
  maxPrice: number | null;
  minPrice: number | null;
  availableOnly: boolean | null;
};

type View = "search" | "chat" | "voice";

function AppContent({ user, signOut }: { user: any; signOut: any }) {
  const [view, setView] = useState<View>("search");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [parsedFilters, setParsedFilters] = useState<ParsedFilters | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(searchQuery?: string) {
    const q = searchQuery ?? query;
    if (!q.trim()) return;

    setQuery(q);
    setLoading(true);
    setError(null);
    setSearched(true);
    setParsedFilters(null);

    try {
      const { data, errors } = await getClient().queries.searchProducts({
        query: q,
        topK: 6,
      });

      if (errors && errors.length > 0) {
        setError(errors[0].message);
        setProducts([]);
      } else if (data) {
        setProducts((data.products as Product[]) ?? []);
        setParsedFilters((data.parsedFilters as ParsedFilters) ?? null);
      }
    } catch (err: any) {
      setError(err.message ?? "Something went wrong");
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <div className="user-bar">
        <span className="user-email">{user?.signInDetails?.loginId ?? "User"}</span>
        <button type="button" className="sign-out-btn" onClick={signOut}>
          Sign out
        </button>
      </div>

      <header className="app-header">
        <h1>
          <span className="icon" aria-hidden="true">
            🔍
          </span>
          Product Search
        </h1>
        <p className="subtitle">
          Ask in natural language — powered by DynamoDB Vector Search
        </p>

        <nav className="view-tabs" aria-label="View switcher">
          <button
            type="button"
            className={`tab ${view === "search" ? "active" : ""}`}
            onClick={() => setView("search")}
          >
            Search
          </button>
          <button
            type="button"
            className={`tab ${view === "chat" ? "active" : ""}`}
            onClick={() => setView("chat")}
          >
            Chat Assistant
          </button>
          <button
            type="button"
            className={`tab ${view === "voice" ? "active" : ""}`}
            onClick={() => setView("voice")}
          >
            Voice Agent
          </button>
        </nav>
      </header>

      {view === "search" && (
        <>
          <SearchBar
            value={query}
            onChange={setQuery}
            onSearch={() => handleSearch()}
            loading={loading}
          />

          {!searched && (
            <SuggestionChips
              onSelect={(suggestion) => {
                setQuery(suggestion);
                handleSearch(suggestion);
              }}
            />
          )}

          {error && (
            <div className="error-message" role="alert">
              <span>⚠️</span> {error}
            </div>
          )}

          {loading && (
            <div className="loading">
              <div className="spinner" aria-hidden="true" />
              <p>Searching products by meaning...</p>
            </div>
          )}

          {!loading && parsedFilters && (
            <ParsedFiltersPanel filters={parsedFilters} />
          )}

          {!loading && searched && products.length === 0 && !error && (
            <div className="empty-state">
              <p>No products found. Try a different description.</p>
            </div>
          )}

          {!loading && products.length > 0 && (
            <section className="results" aria-label="Search results">
              <p className="results-count">
                {products.length} product
                {products.length !== 1 ? "s" : ""} found
              </p>
              <div className="product-grid">
                {products.map((product) => (
                  <ProductCard key={product.productId} product={product} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {view === "chat" && <ChatView />}

      {view === "voice" && <VoiceView />}

      <footer className="app-footer">
        <p>
          Built with <strong>AWS Amplify Gen 2</strong> ·{" "}
          <strong>DynamoDB Vector Search</strong> ·{" "}
          <strong>Amazon Bedrock</strong>
        </p>
      </footer>
    </div>
  );
}

function App() {
  return (
    <Authenticator>
      {({ user, signOut }) => <AppContent user={user} signOut={signOut} />}
    </Authenticator>
  );
}

export default App;
