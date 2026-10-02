// Testes do banco de exemplos fictícios. Rode com: node conhecimento/exemplos.test.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { EXEMPLOS_BOPM, selecionarExemplos, exemplosParaPrompt, normalizar } = require("./exemplos-bopm.js");

let total = 0, falhas = 0;
function ok(cond, msg) {
  total++;
  if (cond) console.log(`  ✓ ${msg}`);
  else { falhas++; console.log(`  ✗ ${msg}`); }
}

console.log("Estrutura dos exemplos");
const ids = new Set();
for (const ex of EXEMPLOS_BOPM) {
  const campos = ex.id && ex.tipo && ex.relato && ex.historico && Array.isArray(ex.palavras) && ex.palavras.length > 0;
  ok(campos, `${ex.id}: tem id, tipo, relato, histórico e palavras-chave`);
  ok(!ids.has(ex.id), `${ex.id}: id único`);
  ids.add(ex.id);
  ok(ex.palavras.every((p) => p === normalizar(p)), `${ex.id}: palavras em minúsculas e sem acento`);
  ok(ex.palavras.every((p) => !/^\d+$/.test(p)), `${ex.id}: sem palavra só de número (casaria com "14 dp")`);
  ok(!/setor\s+[a-z]/i.test(ex.historico), `${ex.id}: não cita nome de setor`);
  ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}|\b[A-Z]{3}-?\d[A-Z0-9]\d{2}\b/.test(ex.relato + ex.historico), `${ex.id}: sem CPF ou placa`);
  ok(ex.historico.length < 1600, `${ex.id}: histórico enxuto (${ex.historico.length} caracteres)`);
}

console.log("Seleção por tipo de ocorrência");
const casos = [
  ["vitima rendida por dois homens de moto, levaram celular, reconheceu os dois. conduzidos a 14 dp", "roubo-transeunte-flagrante"],
  ["denuncia de ponto de venda, 30 pinos de cocaina e 15 trouxas de maconha", "trafico-drogas-flagrante"],
  ["condutor na blitz com halito etilico recusou o bafometro", "embriaguez-volante-recusa"],
  ["o marido agrediu a esposa, ela tem marca no braço, quer medida protetiva", "violencia-domestica-lesao"],
  ["na consulta deu mandado de prisão em aberto", "mandado-prisao"],
  ["cachorro acorrentado sem agua, maus tratos", "maus-tratos-animal"],
];
for (const [relato, esperado] of casos) {
  const ids = selecionarExemplos(relato).map((e) => e.id);
  ok(ids[0] === esperado, `"${relato.slice(0, 40)}…" → ${esperado} (veio: ${ids.join(", ") || "nenhum"})`);
}
ok(selecionarExemplos("abuso").length === 0, `"abuso" não casa com "uso"`);
ok(selecionarExemplos("relato qualquer sem termos").length === 0, "relato sem termo conhecido não traz exemplo");
ok(selecionarExemplos("roubo trafico arma embriaguez desacato furto dano").length <= 3, "no máximo 3 exemplos por pedido");

console.log("Tamanho no prompt");
const maior = Math.max(...EXEMPLOS_BOPM.map((ex) => exemplosParaPrompt(ex.relato + " " + ex.palavras.join(" ")).length));
// O prompt base tem ~26 mil caracteres e o Worker aceita até 60 mil.
ok(maior < 8000, `pior caso de exemplos no prompt: ${maior} caracteres (limite deste teste: 8000)`);

console.log(`\n${total - falhas}/${total} verificações passaram.`);
process.exit(falhas ? 1 : 0);
