/* Cadastro de produtos CDAM — biblioteca compartilhada por todos os sistemas.
   Uso:  const P = await import("https://estoquecdammm-ux.github.io/produtos-cdam/produtos.mjs");
         const r = await P.buscar("74594.916.0/3");   // {codigo, descricao, fonte: "cadastro"|"aprendido"} ou null
         await P.aprender("12345.678.0", "DESCRIÇÃO DIGITADA", "auditoria");
   Cadastro oficial: produtos.json (gerado pela página de gestão a partir do relatório do Senior).
   Códigos aprendidos: Firestore do projeto auditoria-cdam, coleção produtos_aprendidos (id = raiz do código). */

const FIREBASE = {
  apiKey: "AIzaSyD7Xx6yX9xXRjc2VnEqQv0Bfarwhli5bCA",
  authDomain: "auditoria-cdam.firebaseapp.com",
  projectId: "auditoria-cdam",
  storageBucket: "auditoria-cdam.firebasestorage.app",
  messagingSenderId: "51456289260",
  appId: "1:51456289260:web:18ad0b73a1602f1c3638c9",
};
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const COLECAO = "produtos_aprendidos";
const BASE = new URL(".", import.meta.url).href;
const CHAVE_CACHE = "produtos-cdam:catalogo";

let catalogo = null, versao = null, promCat = null, promFb = null;
const aprendidos = new Map();

/** Raiz do código (sem o volume /N), em maiúsculas e sem espaços. */
export function raizDe(cod) {
  return String(cod ?? "").trim().toUpperCase().replace(/\s+/g, "").split("/")[0];
}
/** Volume do código (o número depois da barra), ou null. */
export function volumeDe(cod) {
  const m = String(cod ?? "").trim().match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

function lerCache() {
  try { const c = JSON.parse(localStorage.getItem(CHAVE_CACHE) || "null"); if (c && c.p) return c; } catch (e) { /* sem cache */ }
  return null;
}
function gravarCache(j) { try { localStorage.setItem(CHAVE_CACHE, JSON.stringify(j)); } catch (e) { /* armazenamento cheio ou bloqueado */ } }

/** Carrega o cadastro oficial (usa o guardado no aparelho se estiver sem internet). */
export function carregar() {
  return promCat ||= (async () => {
    const cache = lerCache();
    if (cache) { catalogo = cache.p; versao = cache.versao; }
    try {
      const r = await fetch(BASE + "produtos.json", { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      catalogo = j.p || {}; versao = j.versao || null;
      if (!cache || cache.versao !== j.versao) gravarCache(j);
    } catch (e) {
      if (!catalogo) { catalogo = {}; console.warn("produtos-cdam: cadastro indisponível", e); }
    }
    return { total: Object.keys(catalogo).length, versao };
  })();
}
export async function info() { await carregar(); return { total: Object.keys(catalogo).length, versao }; }

function firebase() {
  return promFb ||= (async () => {
    const [{ initializeApp, getApps }, au, fs] = await Promise.all([
      import(SDK + "firebase-app.js"), import(SDK + "firebase-auth.js"), import(SDK + "firebase-firestore.js"),
    ]);
    const app = getApps().find(a => a.name === "produtos-cdam") || initializeApp(FIREBASE, "produtos-cdam");
    const auth = au.getAuth(app);
    if (!auth.currentUser) await au.signInAnonymously(auth);
    return { db: fs.getFirestore(app), fs };
  })().catch(e => { promFb = null; throw e; });
}

function noCatalogo(r) {
  if (catalogo[r]) return r;
  if (/^\d+\.\d+$/.test(r) && catalogo[r + ".0"]) return r + ".0"; // digitou sem o ".0" final
  return null;
}

/** Busca a descrição do código. Retorna {codigo, descricao, fonte} ou null. */
export async function buscar(cod) {
  const r = raizDe(cod);
  if (!r || r.length < 3) return null;
  await carregar();
  const k = noCatalogo(r);
  if (k) return { codigo: k, descricao: catalogo[k], fonte: "cadastro" };
  if (aprendidos.has(r)) return aprendidos.get(r);
  try {
    const { db, fs } = await firebase();
    const s = await fs.getDoc(fs.doc(db, COLECAO, r));
    const res = s.exists() ? { codigo: r, descricao: s.data().descricao, fonte: "aprendido" } : null;
    aprendidos.set(r, res);
    return res;
  } catch (e) { console.warn("produtos-cdam: aprendidos indisponíveis", e); return null; }
}

/** Guarda um código novo digitado à mão (só se não existir no cadastro nem nos aprendidos). */
export async function aprender(cod, descricao, sistema = "") {
  const r = raizDe(cod), d = String(descricao ?? "").trim().replace(/\s+/g, " ").slice(0, 150);
  if (!r || r.length < 3 || !d) return false;
  await carregar();
  if (noCatalogo(r)) return false;
  const atual = await buscar(r);
  if (atual) return false;
  try {
    const { db, fs } = await firebase();
    const agora = new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace("Z", "-03:00").replace(/\.\d{3}/, "");
    await fs.setDoc(fs.doc(db, COLECAO, r), { codigo: r, descricao: d, sistema: String(sistema).slice(0, 40), criado_em: agora });
    aprendidos.set(r, { codigo: r, descricao: d, fonte: "aprendido" });
    return true;
  } catch (e) { console.warn("produtos-cdam: não foi possível aprender", e); return false; }
}

/** Lista os códigos aprendidos (para a página de gestão). */
export async function listarAprendidos() {
  const { db, fs } = await firebase();
  const snap = await fs.getDocs(fs.collection(db, COLECAO));
  return snap.docs.map(d => d.data()).sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em)));
}

/** Para campos de formulário: liga um input de código a um de descrição.
   opções: { dica: elemento para mensagens, sistema: nome do sistema } — devolve função que diz se deve aprender ao salvar. */
export function ligarCampos(inputCodigo, inputDescricao, opcoes = {}) {
  let tm = null, auto = false, fonte = null, ultimo = "";
  const dica = opcoes.dica || null;
  const msg = (t, tipo) => { if (dica) { dica.textContent = t; dica.dataset.tipo = tipo || ""; } };
  const rodar = async () => {
    const v = inputCodigo.value, r = raizDe(v);
    if (r === ultimo) return;
    ultimo = r;
    if (!r || r.length < 3) { fonte = null; msg("", ""); return; }
    msg("Procurando…", "busca");
    const res = await buscar(v);
    if (raizDe(inputCodigo.value) !== r) return; // digitou outra coisa enquanto buscava
    if (res) {
      fonte = res.fonte;
      if (!inputDescricao.value.trim() || auto) { inputDescricao.value = res.descricao; auto = true; }
      msg(res.fonte === "cadastro" ? "✓ Descrição do cadastro" : "✓ Descrição aprendida (digitada antes)", "ok");
    } else {
      fonte = "novo";
      if (auto) { inputDescricao.value = ""; auto = false; }
      msg("Código fora do cadastro: escreva a descrição e ela fica salva para as próximas vezes", "novo");
    }
  };
  inputCodigo.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(rodar, 350); });
  inputCodigo.addEventListener("blur", () => { clearTimeout(tm); rodar(); });
  inputDescricao.addEventListener("input", () => { auto = false; });
  if (inputCodigo.value) rodar();
  return {
    deveAprender: () => fonte === "novo" && !!inputDescricao.value.trim() && !!raizDe(inputCodigo.value),
    aprenderAgora: () => fonte === "novo" ? aprender(inputCodigo.value, inputDescricao.value, opcoes.sistema) : Promise.resolve(false),
  };
}
