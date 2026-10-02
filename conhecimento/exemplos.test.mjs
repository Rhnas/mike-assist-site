// Testes do banco de exemplos fictícios. Rode com: node conhecimento/exemplos.test.mjs
// Usa o mesmo leitor do Worker, para testar exatamente o que vai para a IA.
import { readFileSync } from "fs";
import "../worker/worker.js";

const T = globalThis.__mikeAssistTeste;
const bruto = readFileSync(new URL("./exemplos-ficticios.txt", import.meta.url), "utf8");
const EXEMPLOS_BOPM = T.lerExemplos(bruto);
const normalizar = T.normalizar;
const selecionarExemplos = (relato) => T.selecionarExemplos(EXEMPLOS_BOPM, relato);
const base = {
  instrucoes: "{{EXEMPLOS_REAIS}}{{EXEMPLOS_DO_TIPO}}{{TABELA_CODIGOS}}",
  reais: "", tabela: "", ficticios: EXEMPLOS_BOPM,
};
const exemplosParaPrompt = (relato) => T.montarPromptHistorico(base, relato);

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
  ok(ex.palavras.length === new Set(ex.palavras).size, `${ex.id}: sem palavra repetida`);
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
ok(maior < 8000, `pior caso de exemplos no prompt: ${maior} caracteres (limite deste teste: 8000)`);

console.log(`\n${total - falhas}/${total} verificações passaram.`);
process.exit(falhas ? 1 : 0);
