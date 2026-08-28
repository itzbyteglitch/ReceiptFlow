import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  FileText,
  Loader2,
  Receipt,
  Search,
  Trash2,
  Upload,
  Wallet,
  X
} from "lucide-react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type Item = {
  id: string;
  name: string;
  description: string;
  category: string;
  quantity: number;
  unit: string;
  unit_price: number;
  total_price: number;
};

type ReceiptRecord = {
  id: string;
  merchant: { name: string; address: string; city: string; state: string; country: string; gstin: string };
  receipt: { type: string; invoice_number: string; shopping_date: string; shopping_time: string; currency: string };
  customer: { name: string; id: string; address: string };
  amounts: { subtotal: number; discount: number; tax: number; round_off: number; total: number; paid: number; pending: number };
  payment: { method: string; status: string };
  items: Item[];
  metadata: { receipt_owner: string; tags: string[]; notes: string; confidence: number; warnings: string[] };
  uploaded_at: string;
};

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:8787").replace(/\/$/, "");

function clientId() {
  const key = "receiptflow-client-id";
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
  }
  return value;
}

const money = (value: number, currency = "INR") =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(value || 0);

function App() {
  const [records, setRecords] = useState<ReceiptRecord[]>([]);
  const [selected, setSelected] = useState<ReceiptRecord | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState(false);
  const [token, setToken] = useState(() => localStorage.getItem("receiptflow-session"));
  const [accountLabel, setAccountLabel] = useState(() => localStorage.getItem("receiptflow-account-label") || "Account");
  const [showUploadOptions, setShowUploadOptions] = useState(false);

  function logout() {
    localStorage.removeItem("receiptflow-session");
    localStorage.removeItem("receiptflow-account-label");
    setToken(null);
    setRecords([]);
    setSelected(null);
  }

  async function load() {
    if (!token) return;
    const response = await fetch(`${API_URL}/api/receipts`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401) { logout(); return; }
    if (!response.ok) throw new Error("Could not load receipts");
    setRecords(await response.json());
  }

  useEffect(() => { load().catch(() => setMessage("Backend is not connected yet.")); }, [token]);

  async function upload(file: File) {
    setUploading(true);
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("userId", clientId());
      const response = await fetch(`${API_URL}/api/receipts`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Processing failed");
      setRecords((current) => [data, ...current]);
      setSelected(data);
      setMessage("Receipt processed successfully.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this receipt permanently?")) return;
    const response = await fetch(`${API_URL}/api/receipts/${id}?userId=${encodeURIComponent(clientId())}`, { method: "DELETE" });
    if (!response.ok) {
      setMessage("Could not delete receipt.");
      return;
    }
    setRecords((current) => current.filter((r) => r.id !== id));
    setSelected(null);
    setMessage("Receipt deleted.");
  }

  const filtered = records.filter((r) =>
    [r.merchant.name, r.receipt.invoice_number, r.metadata.notes, ...r.items.map((i) => i.name)]
      .join(" ").toLowerCase().includes(search.toLowerCase())
  );

  const total = records.reduce((sum, r) => sum + r.amounts.total, 0);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthTotal = records.filter((r) => r.receipt.shopping_date.startsWith(currentMonth)).reduce((sum, r) => sum + r.amounts.total, 0);

  const categories = Object.entries(records.flatMap((r) => r.items).reduce<Record<string, number>>((a, i) => {
    a[i.category] = (a[i.category] || 0) + i.total_price; return a;
  }, {})).sort((a,b) => b[1]-a[1]).slice(0, 6).map(([name, value]) => ({ name, value }));

  if (!token) return <Login apiUrl={API_URL} onLogin={(value, label) => { localStorage.setItem("receiptflow-session", value); localStorage.setItem("receiptflow-account-label", label); setToken(value); setAccountLabel(label); }} />;

  if (selected) {
    return <Details record={selected} onBack={() => setSelected(null)} onDelete={() => remove(selected.id)} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Receipt size={20}/></div><div><strong>ReceiptFlow</strong><span>Receipt intelligence</span></div></div>
      </header>

      <section className="hero">
        <div><p className="eyebrow">PRIVATE BY DESIGN</p><h1>Your receipts, turned into useful data.</h1><p>AI extracts spending information into a searchable dashboard. Receipt images are processed privately and are never displayed or stored by ReceiptFlow.</p></div>
        <div className="account-area"><span>Logged in as <strong>{accountLabel}</strong></span><button className="back" onClick={logout}>Sign out</button></div>
      </section>

      {message && <div className="notice"><span>{message}</span><button onClick={() => setMessage("")}><X size={16}/></button></div>}

      <section className="stats">
        <Stat icon={<Wallet/>} label="Total spending" value={money(total)} />
        <Stat icon={<CalendarDays/>} label="This month" value={money(monthTotal)} />
        <Stat icon={<FileText/>} label="Receipts" value={String(records.length)} />
      </section>

      <section className={`dropzone ${dragging ? "dragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); const file=e.dataTransfer.files[0]; if(file) upload(file); }} onClick={() => { if (window.matchMedia("(max-width: 700px)").matches) setShowUploadOptions(true); else document.getElementById("receipt-file-input")?.click(); }} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { if (window.matchMedia("(max-width: 700px)").matches) setShowUploadOptions(true); else document.getElementById("receipt-file-input")?.click(); } }}>
        {uploading ? <><Loader2 className="spin" size={28}/><strong>Analyzing receipt…</strong><span>Extracting merchant, dates, items, taxes and payment details.</span></> : <><Upload size={28}/><strong>Drop a receipt here</strong><span>Tap to take a photo or choose from your gallery</span><input id="receipt-file-input" type="file" accept="image/*" hidden onChange={(e) => { const file=e.target.files?.[0]; if (file) upload(file); e.currentTarget.value=""; }} /><input id="receipt-camera-input" type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const file=e.target.files?.[0]; if (file) upload(file); e.currentTarget.value=""; }} /></>}
      </section>
      {showUploadOptions && <div className="upload-modal-backdrop" onClick={() => setShowUploadOptions(false)}>
        <div className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-options-title" onClick={(e) => e.stopPropagation()}>
          <div className="upload-modal-head"><div><p className="eyebrow">UPLOAD RECEIPT</p><h2 id="upload-options-title">Choose a source</h2></div><button className="icon-button" onClick={() => setShowUploadOptions(false)} aria-label="Close"><X size={18}/></button></div>
          <button className="upload-option" onClick={() => { setShowUploadOptions(false); document.getElementById("receipt-camera-input")?.click(); }}><span className="upload-option-icon">📷</span><span><strong>Take a photo</strong><small>Use your camera</small></span></button>
          <button className="upload-option" onClick={() => { setShowUploadOptions(false); document.getElementById("receipt-file-input")?.click(); }}><span className="upload-option-icon">🖼️</span><span><strong>Choose from gallery</strong><small>Select an existing receipt image</small></span></button>
          <button className="upload-cancel" onClick={() => setShowUploadOptions(false)}>Cancel</button>
        </div>
      </div>}

      <section className="grid-two">
        <Panel title="Category breakdown" icon={<BarChart3/>}><ResponsiveContainer width="100%" height={250}><PieChart><Pie data={categories} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={3}>{categories.map((_,i)=><Cell key={i}/>)}</Pie><Tooltip formatter={(v) => money(Number(v))}/></PieChart></ResponsiveContainer><div className="legend">{categories.map(c=><span key={c.name}><i/>{c.name} · {money(c.value)}</span>)}</div></Panel>
      </section>

      <section className="panel">
        <div className="section-head"><div><h2>Receipts</h2><span>{filtered.length} records</span></div><div className="search"><Search size={17}/><input placeholder="Search receipts…" value={search} onChange={(e)=>setSearch(e.target.value)}/></div></div>
        <div className="receipt-list">
          {filtered.length === 0 ? <div className="empty"><FileText size={32}/><strong>No receipts yet</strong><span>Upload your first receipt to start building your dashboard.</span></div> : filtered.map(r => <button className="receipt-row" key={r.id} onClick={()=>setSelected(r)}>
            <div className="receipt-icon"><Receipt size={19}/></div><div className="receipt-main"><strong>{r.merchant.name}</strong><span>Shopping: {displayDate(r.receipt.shopping_date)} · Uploaded: {displayDateTime(r.uploaded_at)}</span><small>{r.metadata.notes}</small></div><strong className="amount">{money(r.amounts.total, r.receipt.currency)}</strong>
          </button>)}
        </div>
      </section>
      <Footer />
    </main>
  );
}

function Details({record,onBack,onDelete,onSave}:{record:ReceiptRecord;onBack:()=>void;onDelete:()=>void;onSave:(updated:ReceiptRecord)=>void}) {
  const [editing,setEditing]=useState(false);
  const [saving,setSaving]=useState(false);
  const [form,setForm]=useState({merchant:{...record.merchant},receipt:{...record.receipt},customer:{...record.customer},payment:{...record.payment},metadata:{...record.metadata}});
  function set(path:string,value:string){ setForm((f:any)=>{const [section,key]=path.split(".");return {...f,[section]:{...f[section],[key]:value}};}); }
  async function save(){
    setSaving(true);
    try{
      const response=await fetch(API_URL+"/api/receipts/"+record.id,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:"Bearer "+(localStorage.getItem("receiptflow-session")||"")},body:JSON.stringify(form)});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||"Could not save changes.");
      onSave(data);setEditing(false);
    }catch(e){alert(e instanceof Error?e.message:"Could not save changes.");}finally{setSaving(false);}
  }
  const field=(label:string,path:string)=>{const [section,key]=path.split(".");return <label className="edit-field"><span>{label}</span><input value={(form as any)[section][key]} onChange={e=>set(path,e.target.value)}/></label>;};
  return <main className="app-shell"><header className="topbar"><button className="back" onClick={onBack}><ArrowLeft size={18}/> Dashboard</button><div className="detail-actions"><button className="secondary-button" onClick={()=>setEditing(true)}>Edit details</button><button className="danger" onClick={onDelete}><Trash2 size={17}/> Delete receipt</button></div></header>
    <section className="detail-hero"><p className="eyebrow">{record.receipt.type.replaceAll("_"," ").toUpperCase()}</p><h1>{record.merchant.name}</h1><p>{record.metadata.notes}</p><div className="detail-meta"><span><CalendarDays size={16}/> Shopping: {displayDate(record.receipt.shopping_date)}</span><span><Upload size={16}/> Uploaded: {displayDateTime(record.uploaded_at)}</span></div></section>
    {record.metadata.warnings.length>0&&<div className="warning"><AlertTriangle size={18}/><div><strong>Extraction warnings</strong>{record.metadata.warnings.map(w=><span key={w}>{w}</span>)}</div></div>}
    <section className="grid-two"><Panel title="Receipt information"><Info label="Invoice / receipt no." value={record.receipt.invoice_number}/><Info label="Customer" value={record.customer.name}/><Info label="Location" value={[record.merchant.city,record.merchant.state].filter(x=>x!=="unspecified").join(", ")||"unspecified"}/><Info label="Payment" value={record.payment.method}/><Info label="Status" value={record.payment.status}/><Info label="Confidence" value={Math.round(record.metadata.confidence*100)+"%"}/></Panel>
      <Panel title="Amounts"><Info label="Subtotal" value={money(record.amounts.subtotal,record.receipt.currency)}/><Info label="Discount" value={money(record.amounts.discount,record.receipt.currency)}/><Info label="Tax" value={money(record.amounts.tax,record.receipt.currency)}/><Info label="Paid" value={money(record.amounts.paid,record.receipt.currency)}/><Info label="Pending" value={money(record.amounts.pending,record.receipt.currency)}/><Info label="Total" value={money(record.amounts.total,record.receipt.currency)} strong/></Panel></section>
    <section className="panel"><div className="section-head"><div><h2>Items</h2><span>{record.items.length} items</span></div></div><div className="items-table"><div className="item-head"><span>Item</span><span>Category</span><span>Qty</span><span>Total</span></div>{record.items.map(i=><div className="item-row" key={i.id}><span><strong>{i.name}</strong><small>{i.description}</small></span><span>{i.category}</span><span>{i.quantity} {i.unit}</span><strong>{money(i.total_price,record.receipt.currency)}</strong></div>)}</div></section>
    {editing&&<div className="edit-modal-backdrop"><section className="edit-modal"><div className="upload-modal-head"><div><p className="eyebrow">EDIT RECEIPT</p><h2>Receipt details</h2><small>Prices, totals, taxes and item amounts are locked.</small></div><button className="icon-button" onClick={()=>setEditing(false)}><X size={18}/></button></div><div className="edit-grid">
      {field("Vendor / merchant","merchant.name")}{field("Address","merchant.address")}{field("City","merchant.city")}{field("State","merchant.state")}{field("Country","merchant.country")}{field("GSTIN","merchant.gstin")}{field("Phone","merchant.phone")}
      {field("Receipt type","receipt.type")}{field("Invoice / receipt no.","receipt.invoice_number")}{field("Shopping date","receipt.shopping_date")}{field("Shopping time","receipt.shopping_time")}{field("Customer name","customer.name")}{field("Customer ID","customer.id")}{field("Customer address","customer.address")}{field("Payment method","payment.method")}{field("Payment status","payment.status")}
      <label className="edit-field edit-wide"><span>Receipt owner</span><input value={form.metadata.receipt_owner} onChange={e=>set("metadata.receipt_owner",e.target.value)}/></label><label className="edit-field edit-wide"><span>Notes</span><textarea value={form.metadata.notes} onChange={e=>set("metadata.notes",e.target.value)}/></label>
    </div><div className="edit-footer"><button className="upload-cancel" onClick={()=>setEditing(false)}>Cancel</button><button className="login-button save-button" onClick={save} disabled={saving}>{saving?"Saving…":"Save changes"}</button></div></section></div>}
    <p className="privacy-note"><CheckCircle2 size={16}/> ReceiptFlow stores extracted receipt data only; original images are not displayed or stored.</p>
    <Footer />
  </main>
}

function Footer() {
  return <footer className="site-footer">
    <span>ReceiptFlow © 2026</span>
    <span className="footer-separator">|</span>
    <a href="https://github.com/itzbyteglitch" target="_blank" rel="noreferrer">Made by ItzByteGlitch</a>
  </footer>;
}

function Login({apiUrl,onLogin}:{apiUrl:string;onLogin:(token:string,label:string)=>void}) {
  const [code,setCode]=useState("");
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");

  async function submit(e:React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      const response=await fetch(`${apiUrl}/api/auth/login`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({code})
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(data.error || "Login failed.");
      onLogin(data.token,data.label || "Account");
    } catch(error) {
      setError(error instanceof Error ? error.message : "Login failed.");
    } finally { setLoading(false); }
  }

  return <main className="app-shell login-shell">
    <section className="login-card">
      <div className="brand"><div className="brand-mark"><Receipt size={20}/></div><div><strong>ReceiptFlow</strong><span>Receipt intelligence</span></div></div>
      <div className="login-copy"><p className="eyebrow">PRIVATE ACCESS</p><h1>Sign in to ReceiptFlow.</h1><p>Enter your access code to access your private receipt dashboard.</p></div>
      <form onSubmit={submit}>
        <label className="login-label" htmlFor="access-code">Access code</label>
        <input id="access-code" className="login-input" type="password" value={code} onChange={e=>setCode(e.target.value)} placeholder="Enter your access code" autoComplete="current-password" autoFocus />
        {error && <div className="notice"><span>{error}</span></div>}
        <button className="login-button" disabled={loading || !code}>{loading ? "Signing in…" : "Continue"}</button>
      </form>
    </section>
    <Footer />
  </main>;
}

function Stat({icon,label,value}:{icon:React.ReactNode;label:string;value:string}) { return <div className="stat"><div className="stat-icon">{icon}</div><span>{label}</span><strong>{value}</strong></div> }
function Panel({title,icon,children}:{title:string;icon?:React.ReactNode;children:React.ReactNode}) { return <section className="panel"><div className="panel-title"><h2>{title}</h2>{icon}</div>{children}</section> }
function Info({label,value,strong}:{label:string;value:string;strong?:boolean}) { return <div className="info"><span>{label}</span><strong className={strong?"highlight":""}>{value}</strong></div> }
function displayDate(value:string) { if(value==="unspecified") return "Unspecified"; const d=new Date(value+"T00:00:00"); return isNaN(d.getTime())?value:d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"}); }
function displayDateTime(value:string) { const d=new Date(value); return isNaN(d.getTime())?value:d.toLocaleString("en-IN",{day:"2-digit",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"}); }

export default App;
