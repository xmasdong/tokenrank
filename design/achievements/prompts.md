# 奖章生成规格

使用内置 `image_gen`，分别生成四个独立资产；`transparent_background=true`。未使用外部 CLI/API 生成。以下是生成方向与各档提示词规格，供后续保持风格一致。

## 共通提示词

Use case: stylized-concept.
Asset type: production-quality standalone 3D collectible achievement badge for TokenRank, a WeChat mini-program for AI coding token usage.

Direction: expensive miniature crafted object, precision jewelry / video game collectible. Geometric token core, deep beveled contours, layered machined metal, glossy dark forest-green vitreous enamel, ivory ceramic details. Central symbol is a simple sculpted architectural T made from three solid rectangular bars.

Exactly one complete badge, centered nearly front-facing with a subtle 8-degree turn. The object fills about 78% of a square composition. Transparent alpha background. Soft studio light from the upper left. No floor, pedestal, external shadow, numbers, other letters, labels, existing-brand logos, watermarks, interface, multiple objects, neon purple/blue aura or particles.

## 铜质

Compact, thick copper-bronze hexagon. Dark green enamel inset. Etched circuit corners. Simple raised ivory T. Restrained geometry without wings. Clearly the first tier of the same collectible family.

## 铂银

Faceted platinum-silver octagon. Four tiny inset stones. Two lower architectural fins. Forest-green enamel and raised ivory T. A visible silhouette upgrade from the bronze hexagon, with clean, precise beveled edges.

## 鎏金

Elaborate champagne-gold star / octagon. Gold and ivory laurel branches embracing the lower half. Microcircuit etching. Emerald lens beneath the raised ivory T. Layered depth, strong crafted metal highlights, visibly more elaborate than platinum.

## 镶晶金

Eight-point gold frame with four large clear-cut crystal facets in platinum mounts. Faceted emerald crystal center. Raised ivory T. Gold angular laurel, topped with a stepped crystal crown. Highest tier: complex silhouette, jewelry-quality material and crisp optical facets, while retaining a readable central symbol at small sizes.

## 资源打包

保留生成原图后，仅进行尺寸与格式打包，未重绘或去除透明通道：

```sh
cwebp -q 88 -alpha_q 100 -m 6 -resize 768 768 source.png -o badge.webp
```

原始生成 PNG 和带个人数据的设计验收画面不进入公开仓库。
