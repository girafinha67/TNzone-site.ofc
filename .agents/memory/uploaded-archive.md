---
name: Arquivos enviados por ZIP
description: Regra para substituir o código do projeto por um arquivo compactado enviado pelo usuário.
---

Ao receber um arquivo compactado como fonte da aplicação, conferir a estrutura na raiz do arquivo e comparar com a árvore atual e o repositório remoto antes de fazer qualquer sobrescrita.

**Why:** O workspace pode conter um scaffold ou artefatos de outro produto, enquanto o arquivo enviado contém a aplicação real. Um envio prematuro pode publicar a estrutura errada ou apagar um site existente.

**How to apply:** Inspecionar o conteúdo do arquivo, preservar os arquivos internos do ambiente, substituir apenas o código do produto e pedir confirmação antes de sobrescrever histórico remoto divergente.