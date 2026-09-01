interface Product {
  productId: string;
  name: string;
  category: string;
  description: string;
  price: number;
  available: boolean;
  score: number | null;
}

interface ProductCardProps {
  product: Product;
}

export function ProductCard({ product }: ProductCardProps) {
  const similarityPercent =
    product.score != null ? Math.round((1 - product.score / 2) * 100) : null;

  return (
    <article className="product-card">
      <div className="card-header">
        <h3 className="product-name">{product.name}</h3>
        <span className="price">€{product.price}</span>
      </div>

      <span className="category-badge">{product.category}</span>

      <p className="description">{product.description}</p>

      <div className="card-footer">
        <span
          className={`availability ${product.available ? "in-stock" : "out-of-stock"}`}
        >
          <span aria-hidden="true">{product.available ? "●" : "○"}</span>
          {product.available ? "In stock" : "Out of stock"}
        </span>

        {similarityPercent != null && (
          <span className="similarity" title="Cosine similarity match">
            {similarityPercent}% match
          </span>
        )}
      </div>
    </article>
  );
}
