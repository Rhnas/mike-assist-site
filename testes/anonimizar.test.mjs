// Testes do anonimizador. Rode com: node testes/anonimizar.test.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { anonimizar, resumoAnonimizacao } = require("../anonimizar.js");

let total = 0, falhas = 0;
function ok(cond, msg, detalhe = "") {
  total++;
  if (cond) console.log(`  ✓ ${msg}`);
  else { falhas++; console.log(`  ✗ ${msg} ${detalhe}`); }
}
const t = (x) => anonimizar(x).texto;

console.log("Esconde dados pessoais");
const casoB = "abordado o nacional JOAO DA SILVA TESTE, CPF 000.000.000-00, morador da rua das acacias 123 ap 4, telefone 21 90000-0000, com uma porcao de maconha, conduzido";
const b = anonimizar(casoB);
ok(!b.texto.includes("000.000.000-00") && b.texto.includes("[CPF]"), "CPF com pontos", b.texto);
ok(!b.texto.includes("90000-0000") && b.texto.includes("[telefone]"), "telefone com DDD", b.texto);
ok(resumoAnonimizacao(b.contagem) === "1 CPF e 1 telefone", "resumo para o policial", resumoAnonimizacao(b.contagem));
ok(t("cpf 12345678901") === "cpf [CPF]", "CPF só com números");
ok(t("tel (21) 98765-4321") === "tel [telefone]", "telefone com parênteses", t("tel (21) 98765-4321"));
ok(t("ligou do 2234-5678") === "ligou do [telefone]", "telefone fixo sem DDD", t("ligou do 2234-5678"));
ok(t("carro placa ABC-1234 abandonado") === "carro placa [placa] abandonado", "placa antiga");
ok(t("moto placa RIO2A18") === "moto placa [placa]", "placa Mercosul");
ok(t("RG 12.345.678-9 apresentado") === "RG [RG] apresentado", "RG", t("RG 12.345.678-9 apresentado"));
ok(t("identidade nº 123456789") === "IDENTIDADE [RG]", "identidade", t("identidade nº 123456789"));
ok(t("email fulano.teste@exemplo.com.br") === "email [e-mail]", "e-mail");
ok(t("cep 20000-000") === "cep [CEP]", "CEP");

console.log("Não mexe no que não é dado pessoal");
const relatos = [
  "40 pinos de cocaina e 22 trouxas de maconha, R$ 315 em notas",
  "conduzidos a 14 dp por volta das 15h30 do dia 02/10/2026",
  "revolver calibre 38 municiado com 5 cartuchos",
  "RO nº 014-01234/2026, BAM 5678",
  "rua das palmeiras 1250, setor 3, viatura 54-1234",
  "pistola 9mm com carregador e 10 munições",
];
for (const r of relatos) ok(t(r) === r, `mantém: "${r}"`, `→ "${t(r)}"`);
ok(resumoAnonimizacao({}) === "", "resumo vazio quando nada foi escondido");

console.log(`\n${total - falhas}/${total} verificações passaram.`);
process.exit(falhas ? 1 : 0);
