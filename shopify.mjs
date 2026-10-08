// Shopify Admin GraphQL helpers (Workers-native: uses global fetch/FormData/Blob).
// Built from the Worker's `env` per request.

export function makeShopify(env) {
  const SHOP = env.SHOP;
  const TOKEN = env.ADMIN_TOKEN;
  const API = env.API_VERSION || '2024-10';
  const PRODUCT_TYPE = env.PRODUCT_TYPE || 'Bouquet';
  const ENDPOINT = `https://${SHOP}/admin/api/${API}/graphql.json`;

  async function gql(query, variables) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors));
    return json.data;
  }

  const firstErr = (...groups) => {
    for (const g of groups) if (g && g.length) return g[0].message;
    return null;
  };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // file: { name, type, size, bytes: Uint8Array }
  async function stageAndUpload(file) {
    const d = await gql(
      `mutation stage($input:[StagedUploadInput!]!){
         stagedUploadsCreate(input:$input){ stagedTargets{ url resourceUrl parameters{ name value } } userErrors{ message } }
       }`,
      { input: [{ filename: file.name || 'bouquet.jpg', mimeType: file.type || 'image/jpeg', resource: 'IMAGE', httpMethod: 'POST', fileSize: String(file.size) }] }
    );
    const err = firstErr(d.stagedUploadsCreate.userErrors);
    if (err) throw new Error('stagedUploadsCreate: ' + err);
    const t = d.stagedUploadsCreate.stagedTargets[0];
    const form = new FormData();
    for (const p of t.parameters) form.append(p.name, p.value);
    form.append('file', new Blob([file.bytes], { type: file.type || 'image/jpeg' }), file.name || 'bouquet.jpg');
    const up = await fetch(t.url, { method: 'POST', body: form });
    if (!up.ok) throw new Error('Image upload failed: HTTP ' + up.status);
    return t.resourceUrl;
  }

  async function createVendorProduct({ vendor, name, narrative, price, stem, file }) {
    const created = await gql(
      `mutation create($input:ProductInput!){
         productCreate(input:$input){ product{ id handle variants(first:1){ nodes{ id } } } userErrors{ message } }
       }`,
      {
        input: {
          title: name,
          vendor: vendor.business_name,
          descriptionHtml: narrative ? `<p>${esc(narrative)}</p>` : '',
          productType: PRODUCT_TYPE,
          status: 'DRAFT',
          tags: ['obsidian-bloom', `vendor:${vendor.id}`, ...(stem ? [stem] : [])],
          metafields: [
            { namespace: 'custom', key: 'vendor_id', type: 'single_line_text_field', value: String(vendor.id) },
            ...(stem ? [{ namespace: 'custom', key: 'stem_density', type: 'single_line_text_field', value: stem }] : []),
            ...(narrative ? [{ namespace: 'custom', key: 'narrative', type: 'multi_line_text_field', value: narrative }] : []),
          ],
        },
      }
    );
    let err = firstErr(created.productCreate.userErrors);
    if (err) throw new Error('productCreate: ' + err);
    const product = created.productCreate.product;
    const variantId = product.variants.nodes[0]?.id;

    if (variantId) {
      const p = (Number(price) || 0).toFixed(2);
      const priced = await gql(
        `mutation setPrice($productId:ID!,$variants:[ProductVariantsBulkInput!]!){
           productVariantsBulkUpdate(productId:$productId, variants:$variants){ productVariants{ id } userErrors{ message } }
         }`,
        { productId: product.id, variants: [{ id: variantId, price: p }] }
      );
      err = firstErr(priced.productVariantsBulkUpdate.userErrors);
      if (err) throw new Error('productVariantsBulkUpdate: ' + err);
    }

    if (file && file.bytes && file.size) {
      const resourceUrl = await stageAndUpload(file);
      const media = await gql(
        `mutation addMedia($productId:ID!,$media:[CreateMediaInput!]!){
           productCreateMedia(productId:$productId, media:$media){ media{ ... on MediaImage { id } } mediaUserErrors{ message } }
         }`,
        { productId: product.id, media: [{ originalSource: resourceUrl, mediaContentType: 'IMAGE', alt: name }] }
      );
      err = firstErr(media.productCreateMedia.mediaUserErrors);
      if (err) throw new Error('productCreateMedia: ' + err);
    }

    const idNum = product.id.split('/').pop();
    return { gid: product.id, id: idNum, handle: product.handle, adminUrl: `https://${SHOP}/admin/products/${idNum}` };
  }

  async function setProductStatus(gid, status) {
    const d = await gql(
      `mutation upd($input:ProductInput!){ productUpdate(input:$input){ product{ id status } userErrors{ message } } }`,
      { input: { id: gid, status } }
    );
    const err = firstErr(d.productUpdate.userErrors);
    if (err) throw new Error('productUpdate: ' + err);
    return d.productUpdate.product;
  }

  return { SHOP, gql, createVendorProduct, setProductStatus };
}
