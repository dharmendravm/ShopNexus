# Shopify Liquid — Complete Quick Notes

## 1. Liquid Syntax

| Syntax | Definition | Example |
|---|---|---|
| `{{ }}` | Value ko output/display karta hai. | `{{ product.title }}` |
| `{% %}` | Logic/instruction execute karta hai. | `{% if product.available %}` |
| `|` | Value par filter apply karta hai. | `{{ product.title \| upcase }}` |
| `{% comment %}` | Liquid code ko comment karta hai. | `{% comment %}Test{% endcomment %}` |

---

# 2. Variables

| Tag | Definition | Example |
|---|---|---|
| `assign` | Variable mein value store karta hai. | `{% assign name = 'Dharmendra' %}` |
| `capture` | Multiple text/HTML ko variable mein store karta hai. | `{% capture msg %}Hello{% endcapture %}` |
| `increment` | Counter ko 1 se increase karta hai. | `{% increment counter %}` |
| `decrement` | Counter ko 1 se decrease karta hai. | `{% decrement counter %}` |

Example:

```liquid
{% assign name = 'Dharmendra' %}

{{ name }}
```

---

# 3. Conditions

| Tag | Definition | Example |
|---|---|---|
| `if` | Condition true hone par code chalata hai. | `{% if product.available %}` |
| `elsif` | Additional condition check karta hai. | `{% elsif product.price > 500 %}` |
| `else` | Previous conditions false hone par chalta hai. | `{% else %}` |
| `unless` | Condition false hone par code chalata hai. | `{% unless product.available %}` |
| `case` | Ek value ko multiple values se compare karta hai. | `{% case product.type %}` |
| `when` | `case` ke andar matching value define karta hai. | `{% when 'Shirt' %}` |

Example:

```liquid
{% if product.available %}
  In Stock
{% else %}
  Sold Out
{% endif %}
```

---

# 4. Comparison Operators

| Operator | Definition | Example |
|---|---|---|
| `==` | Equal check karta hai. | `product.type == 'Shirt'` |
| `!=` | Not equal check karta hai. | `product.type != 'Shoes'` |
| `>` | Greater than check karta hai. | `product.price > 500` |
| `<` | Less than check karta hai. | `product.price < 500` |
| `>=` | Greater than or equal check karta hai. | `product.price >= 500` |
| `<=` | Less than or equal check karta hai. | `product.price <= 500` |
| `contains` | String/array mein value present hai ya nahi check karta hai. | `product.tags contains 'sale'` |

---

# 5. Logical Operators

| Operator | Definition | Example |
|---|---|---|
| `and` | Dono conditions true honi chahiye. | `available and price > 500` |
| `or` | Kisi ek condition ka true hona enough hai. | `type == 'Shirt' or type == 'Shoes'` |
| `contains` | Value/string/array mein item search karta hai. | `tags contains 'new'` |

Example:

```liquid
{% if product.available and product.price > 500 %}
  Buy Now
{% endif %}
```

---

# 6. Special Values

| Value | Definition | Example |
|---|---|---|
| `blank` | Value blank hai ya nahi check karta hai. | `product.description == blank` |
| `empty` | String/array empty hai ya nahi check karta hai. | `product.tags == empty` |
| `nil` | Value available/null nahi hai. | `product.metafields.custom.test == nil` |
| `true` | Boolean true value. | `product.available == true` |
| `false` | Boolean false value. | `product.available == false` |

---

# 7. Loops

| Method | Definition | Example |
|---|---|---|
| `for` | Collection ke har item par code repeat karta hai. | `{% for tag in product.tags %}` |
| `forloop.index` | Current item ka index 1 se deta hai. | `{{ forloop.index }}` |
| `forloop.index0` | Current item ka index 0 se deta hai. | `{{ forloop.index0 }}` |
| `forloop.first` | Check karta hai current item first hai ya nahi. | `{% if forloop.first %}` |
| `forloop.last` | Check karta hai current item last hai ya nahi. | `{% if forloop.last %}` |
| `forloop.length` | Total loop items ki count deta hai. | `{{ forloop.length }}` |
| `limit` | Loop mein items ki maximum count set karta hai. | `{% for tag in product.tags limit: 3 %}` |
| `offset` | Starting items skip karta hai. | `{% for tag in product.tags offset: 2 %}` |
| `reversed` | Loop ko reverse order mein chalata hai. | `{% for tag in product.tags reversed %}` |
| `break` | Loop ko completely stop karta hai. | `{% break %}` |
| `continue` | Current iteration skip karta hai. | `{% continue %}` |

Example:

```liquid
{% for variant in product.variants %}
  {{ forloop.index }} - {{ variant.title }}
{% endfor %}
```

---

# 8. Shopify Objects

| Object | Definition | Example |
|---|---|---|
| `product` | Current product ki information deta hai. | `{{ product.title }}` |
| `variant` | Product ke individual variant ki information deta hai. | `{{ variant.price }}` |
| `collection` | Current collection ki information deta hai. | `{{ collection.title }}` |
| `cart` | Customer ke current cart ki information deta hai. | `{{ cart.total_price }}` |
| `customer` | Logged-in customer ki information deta hai. | `{{ customer.email }}` |
| `shop` | Store ki information deta hai. | `{{ shop.name }}` |
| `page` | Current Shopify page ki information deta hai. | `{{ page.title }}` |
| `article` | Blog article ki information deta hai. | `{{ article.title }}` |
| `blog` | Blog ki information deta hai. | `{{ blog.title }}` |
| `request` | Current request/page ki information deta hai. | `{{ request.path }}` |
| `section` | Current section ki information deta hai. | `{{ section.id }}` |
| `block` | Current block ki information deta hai. | `{{ block.id }}` |

---

# 9. Product Object

Common product properties:

| Property | Definition | Example |
|---|---|---|
| `title` | Product ka naam. | `{{ product.title }}` |
| `description` | Product description. | `{{ product.description }}` |
| `price` | Product price. | `{{ product.price }}` |
| `compare_at_price` | Original/compare price. | `{{ product.compare_at_price }}` |
| `vendor` | Product vendor. | `{{ product.vendor }}` |
| `type` | Product type. | `{{ product.type }}` |
| `handle` | URL-friendly product identifier. | `{{ product.handle }}` |
| `id` | Product ID. | `{{ product.id }}` |
| `available` | Product availability check. | `{{ product.available }}` |
| `tags` | Product ke tags. | `{{ product.tags }}` |
| `images` | Product images collection. | `{{ product.images }}` |
| `featured_image` | Main/featured product image. | `{{ product.featured_image }}` |
| `variants` | Product ke variants. | `{{ product.variants }}` |
| `options` | Product options. | `{{ product.options }}` |

---

# 10. Variant Object

| Property | Definition | Example |
|---|---|---|
| `id` | Variant ID. | `{{ variant.id }}` |
| `title` | Variant title. | `{{ variant.title }}` |
| `price` | Variant price. | `{{ variant.price }}` |
| `available` | Variant available hai ya nahi. | `{{ variant.available }}` |
| `sku` | Variant SKU. | `{{ variant.sku }}` |
| `inventory_quantity` | Available inventory quantity. | `{{ variant.inventory_quantity }}` |
| `featured_image` | Variant image. | `{{ variant.featured_image }}` |

Example:

```liquid
{% for variant in product.variants %}
  {{ variant.title }} - {{ variant.price | money }}
{% endfor %}
```

---

# 11. Filters — String

| Filter | Definition | Example |
|---|---|---|
| `upcase` | Text ko uppercase karta hai. | `{{ product.title | upcase }}` |
| `downcase` | Text ko lowercase karta hai. | `{{ product.title | downcase }}` |
| `capitalize` | First character ko capitalize karta hai. | `{{ name | capitalize }}` |
| `append` | Text ke end mein value add karta hai. | `{{ name | append: '!' }}` |
| `prepend` | Text ke beginning mein value add karta hai. | `{{ name | prepend: 'Hi ' }}` |
| `replace` | Text ka part replace karta hai. | `{{ name | replace: 'Old', 'New' }}` |
| `remove` | Text ka part remove karta hai. | `{{ name | remove: 'Test' }}` |
| `strip` | Beginning/end ke whitespace remove karta hai. | `{{ name | strip }}` |
| `strip_html` | HTML tags remove karta hai. | `{{ product.description | strip_html }}` |
| `split` | String ko array mein divide karta hai. | `{{ 'a,b,c' | split: ',' }}` |
| `truncate` | Text ko specified length tak shorten karta hai. | `{{ name | truncate: 20 }}` |

---

# 12. Filters — Numbers & Money

| Filter | Definition | Example |
|---|---|---|
| `money` | Price ko store currency format mein display karta hai. | `{{ product.price | money }}` |
| `plus` | Number add karta hai. | `{{ price | plus: 100 }}` |
| `minus` | Number subtract karta hai. | `{{ price | minus: 100 }}` |
| `times` | Number multiply karta hai. | `{{ price | times: 2 }}` |
| `divided_by` | Number divide karta hai. | `{{ price | divided_by: 2 }}` |
| `modulo` | Division ka remainder deta hai. | `{{ 10 | modulo: 3 }}` |
| `round` | Number round karta hai. | `{{ price | round }}` |
| `ceil` | Number ko upper integer par round karta hai. | `{{ price | ceil }}` |
| `floor` | Number ko lower integer par round karta hai. | `{{ price | floor }}` |

---

# 13. Filters — Images

| Filter | Definition | Example |
|---|---|---|
| `image_url` | Image ka CDN URL generate karta hai. | `{{ product.featured_image | image_url: width: 600 }}` |
| `image_tag` | Image ke liye HTML `<img>` generate karta hai. | `{{ product.featured_image | image_url: width: 600 | image_tag }}` |

Common pattern:

```liquid
<img
  src="{{ product.featured_image | image_url: width: 600 }}"
  alt="{{ product.title | escape }}"
>
```

---

# 14. Filters — Arrays

| Filter | Definition | Example |
|---|---|---|
| `join` | Array items ko string mein join karta hai. | `{{ product.tags | join: ', ' }}` |
| `first` | Array ka first item deta hai. | `{{ product.tags | first }}` |
| `last` | Array ka last item deta hai. | `{{ product.tags | last }}` |
| `size` | Array/string ki length deta hai. | `{{ product.tags.size }}` |
| `sort` | Array ko sort karta hai. | `{{ product.tags | sort }}` |
| `uniq` | Duplicate values remove karta hai. | `{{ tags | uniq }}` |
| `reverse` | Array ko reverse karta hai. | `{{ tags | reverse }}` |
| `map` | Collection se specific property values extract karta hai. | `{{ products | map: 'title' }}` |
| `where` | Collection ko condition ke basis par filter karta hai. | `{{ products | where: 'available', true }}` |

---

# 15. `default`

Value empty/nil ho to fallback value provide karta hai.

```liquid
{{ product.vendor | default: 'Unknown Vendor' }}
```

---

# 16. Escape

User/content data ko safely HTML mein output karne ke liye escape karta hai.

```liquid
{{ product.title | escape }}
```

Commonly:

```liquid
alt="{{ product.title | escape }}"
```

---

# 17. Metafields

Metafield existing Shopify resource ke saath custom data store karta hai.

Structure:

```text
resource
  ↓
metafields
  ↓
namespace
  ↓
key
```

Example:

```liquid
{{ product.metafields.custom.material.value }}
```

Common structure:

```text
custom.material
custom.size_guide
custom.video_url
custom.badge
```

---

# 18. Metaobjects

Metaobject custom structured data entity/record hota hai.

Example:

```text
Designer
├── name
├── image
├── bio
└── website
```

Liquid:

```liquid
{% for designer in shop.metaobjects.designer.values %}
  {{ designer.name }}
{% endfor %}
```

Reference metafield:

```liquid
{% assign brand = product.metafields.custom.brand.value %}

{{ brand.name }}
```

---

# 19. Snippets

Snippet reusable Liquid code/component hota hai.

File:

```text
snippets/product-card.liquid
```

Render:

```liquid
{% render 'product-card' %}
```

Data pass karna:

```liquid
{% render 'product-card', product: product %}
```

---

# 20. Sections

Section theme ka reusable/customizable page component hota hai.

Example:

```text
sections/featured-product.liquid
```

Basic structure:

```liquid
<div>
  {{ section.settings.heading }}
</div>

{% schema %}
{
  "name": "Featured Product",
  "settings": []
}
{% endschema %}
```

---

# 21. Section Schema

Schema Shopify Theme Editor ko batata hai ki section mein kya settings available hain.

Example:

```json
{
  "name": "Product Banner",
  "settings": [
    {
      "type": "text",
      "id": "heading",
      "label": "Heading"
    }
  ]
}
```

Access:

```liquid
{{ section.settings.heading }}
```

---

# 22. Common Schema Settings

| Setting | Definition | Example |
|---|---|---|
| `text` | Short text input. | `"type": "text"` |
| `textarea` | Long text input. | `"type": "textarea"` |
| `image_picker` | Image select karne deta hai. | `"type": "image_picker"` |
| `url` | URL select/input. | `"type": "url"` |
| `checkbox` | Boolean toggle. | `"type": "checkbox"` |
| `select` | Options mein se select. | `"type": "select"` |
| `range` | Numeric slider. | `"type": "range"` |
| `color` | Color picker. | `"type": "color"` |
| `product` | Product select karne deta hai. | `"type": "product"` |
| `collection` | Collection select karne deta hai. | `"type": "collection"` |
| `video` | Video select karne deta hai. | `"type": "video"` |

---

# 23. Schema — Blocks

Section ke andar repeatable blocks define kar sakte hain.

Basic structure:

```json
{
  "blocks": [
    {
      "type": "item",
      "name": "Item",
      "settings": []
    }
  ]
}
```

Liquid:

```liquid
{% for block in section.blocks %}
  {{ block.settings.title }}
{% endfor %}
```

---

# 24. Presets

Theme Editor mein section ko add karne ke liye default configuration provide karta hai.

```json
{
  "presets": [
    {
      "name": "Product Banner"
    }
  ]
}
```

---

# 25. Theme Architecture

```text
layout/
templates/
sections/
blocks/
snippets/
assets/
config/
locales/
```

| Folder | Definition |
|---|---|
| `layout` | Overall HTML/layout structure. |
| `templates` | Page-level templates. |
| `sections` | Customizable theme sections. |
| `blocks` | Sections ke andar reusable blocks. |
| `snippets` | Reusable Liquid components. |
| `assets` | CSS, JS, images and other static assets. |
| `config` | Theme configuration/settings. |
| `locales` | Translation/localization files. |

---

# 26. Theme App Extension

Theme App Extension Shopify app ko theme mein UI inject karne deta hai.

Main concepts:

```text
App Block
App Embed
Target
Schema
Assets
Theme Editor
```

---

# 27. App Block

App block theme section ke andar merchant add kar sakta hai.

Concept:

```text
Theme Section
   ↓
Add Block
   ↓
Your App Block
```

Liquid:

```liquid
<div class="my-app-block">
  {{ product.title }}
</div>
```

---

# 28. App Embed

App Embed generally theme ke broader/global functionality ke liye use hota hai.

Example:

```text
Analytics
Tracking
Global JS
Floating widget
```

---

# 29. Liquid + CSS

Separate CSS asset ko load karna:

```liquid
{{ 'product-practice.css' | asset_url | stylesheet_tag }}
```

File:

```text
assets/product-practice.css
```

---

# 30. Liquid + JavaScript

JavaScript asset ko load karna:

```liquid
<script
  src="{{ 'product-practice.js' | asset_url }}"
  defer>
</script>
```

File:

```text
assets/product-practice.js
```

---

# 31. Liquid → JavaScript Data

Liquid se HTML data attribute mein Shopify data pass kar sakte hain.

```liquid
<div
  class="product-card"
  data-product-id="{{ product.id }}"
  data-product-handle="{{ product.handle }}"
>
</div>
```

JavaScript:

```javascript
const card = document.querySelector('.product-card');

console.log(card.dataset.productId);
console.log(card.dataset.productHandle);
```

Flow:

```text
Shopify data
    ↓
Liquid
    ↓
HTML data-attribute
    ↓
JavaScript
```

---

# 32. Liquid → HTML → CSS → JS

Shopify frontend ka basic architecture:

```text
Shopify Data
     ↓
   Liquid
     ↓
    HTML
   ↙    ↘
 CSS     JavaScript
```

Liquid = data/rendering

CSS = styling

JavaScript = interaction

---

# 33. Useful Product Patterns

### Product title

```liquid
{{ product.title }}
```

### Product price

```liquid
{{ product.price | money }}
```

### Product image

```liquid
{{ product.featured_image | image_url: width: 600 }}
```

### Product availability

```liquid
{% if product.available %}
  Available
{% else %}
  Sold Out
{% endif %}
```

### Product tags

```liquid
{% for tag in product.tags %}
  {{ tag }}
{% endfor %}
```

### Product variants

```liquid
{% for variant in product.variants %}
  {{ variant.title }}
{% endfor %}
```

### Product metafield

```liquid
{{ product.metafields.custom.material.value }}
```

### Metaobject

```liquid
{% for item in shop.metaobjects.designer.values %}
  {{ item.name }}
{% endfor %}
```

---

# 34. Most Important Things to Memorize

```text
{{ }}          → Output
{% %}          → Logic
|              → Filter

assign         → Variable
capture        → Capture text

if             → Condition
elsif          → Another condition
else           → Otherwise
unless         → If false
case/when      → Multiple matching conditions

for            → Loop
limit          → Maximum items
offset         → Skip items
break          → Stop loop
continue       → Skip iteration

product        → Product object
variant        → Variant object
collection     → Collection object
cart           → Cart object
customer       → Customer object
shop           → Store object

metafields     → Custom data on resource
metaobjects    → Custom structured records

render         → Render snippet
section        → Theme section
block          → Section block
schema         → Theme editor configuration

asset_url      → Asset URL
stylesheet_tag → CSS loading
defer          → JS loading without blocking HTML
```

# 35. Practical Learning Order

Ab notes complete hain. Practical implementation isi order mein karni hai:

```text
1. Product Object
        ↓
2. Loops
        ↓
3. Filters
        ↓
4. Variants
        ↓
5. Metafields
        ↓
6. Metaobjects
        ↓
7. Snippets
        ↓
8. Sections + Schema
        ↓
9. Theme App Extension
        ↓
10. Liquid + CSS + JS
        ↓
11. Shoppable Video Carousel
```

**Goal:** Syntax ratna nahi hai. Har concept ko apne `liquid-lab` extension mein ek baar use karna hai. Iske baad Liquid ko practically complete maan sakte hain.