// Lista fixa de categorias que um produto pode receber (multi-seleção).
// Usada tanto no formulário de produto do admin quanto no filtro do catálogo.
// Se precisar adicionar/remover uma categoria, mexa só aqui — o mesmo array
// existe no backend em netlify/functions/lib/category-tags.js e precisa
// ficar em sincronia (slugs iguais).
window.RSHOES_CATEGORY_TAGS = [
  { slug: 'low', label: 'Nike' },
  { slug: 'high', label: 'Adidas' },
  { slug: 'slip-on', label: 'New Balance' },
  { slug: 'skate', label: 'Infantis' },
  { slug: 'edicao-limitada', label: 'Linha premium' },
  { slug: 'vans', label: 'Vans' },
];
