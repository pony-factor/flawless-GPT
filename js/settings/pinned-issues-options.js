(() => {
  "use strict";
  const model = globalThis.__ghrcPinnedIssues;
  if (!model || !document.getElementById("pinned-issues-settings")) return;
  const KEY = "pinnedIssues";
  const list = document.getElementById("pinned-issues-list");
  const template = document.getElementById("pinned-issue-template");
  const urlInput = document.getElementById("pinned-issue-url");
  const labelInput = document.getElementById("pinned-issue-label");
  const status = document.getElementById("pinned-issues-status");
  let issues = [], dragged = null, queue = Promise.resolve();
  function message(value, state = "") {
    status.textContent = value;
    status.dataset.state = state;
  }
  function save() {
    const snapshot = issues.map(({url,label})=>({url,label}));
    queue = queue.catch(()=>{}).then(()=>chrome.storage.local.set({[KEY]:snapshot}));
    return queue.catch(error=>message("Saving issues failed: " + error.message, "error"));
  }
  function controls() {
    const rows = [...list.querySelectorAll(".pinned-issue-setting")];
    rows.forEach((row,index)=>{
      row.querySelector(".move-issue-up").disabled = index === 0;
      row.querySelector(".move-issue-down").disabled = index === rows.length - 1;
    });
  }
  function reorder() {
    const byUrl = new Map(issues.map(issue=>[issue.url.toLowerCase(),issue]));
    issues = [...list.querySelectorAll(".pinned-issue-setting")]
      .map(row=>byUrl.get(row.dataset.url.toLowerCase())).filter(Boolean);
    controls();
    void save();
  }
  function move(row,direction) {
    const next = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!next?.classList.contains("pinned-issue-setting")) return;
    list.insertBefore(row,direction < 0 ? next : next.nextElementSibling);
    reorder();
  }
  function entry(issue) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.dataset.url = issue.url;
    row.querySelector(".pinned-issue-name").textContent = issue.label || `${issue.repository} #${issue.number}`;
    row.querySelector(".pinned-issue-repository").textContent = `${issue.owner}/${issue.repository} · #${issue.number}`;
    row.querySelector(".move-issue-up").addEventListener("click",()=>move(row,-1));
    row.querySelector(".move-issue-down").addEventListener("click",()=>move(row,1));
    row.querySelector(".rename-issue").addEventListener("click",()=>{
      const label = window.prompt("Issue label (blank for default):",issue.label);
      if (label === null) return;
      issue.label = label.trim().slice(0,120);
      render(); void save();
    });
    row.querySelector(".remove-issue").addEventListener("click",()=>{
      issues = issues.filter(pin=>pin.url.toLowerCase()!==issue.url.toLowerCase());
      render(); void save();
    });
    return row;
  }
  function render() {
    if (!issues.length) {
      const p=document.createElement("p");
      p.className="pinned-issues-empty";p.textContent="No issues pinned yet.";
      list.replaceChildren(p);return;
    }
    list.replaceChildren(...issues.map(entry));controls();
  }
  function add() {
    let issue;
    try { issue=model.parseIssueUrl(urlInput.value); }
    catch(error) { message(error.message,"error");return; }
    if (issues.some(pin=>pin.url.toLowerCase()===issue.url.toLowerCase())) {
      message("That issue is already pinned.","error");return;
    }
    if (issues.length>=model.MAX_ISSUES) {
      message(`You can pin up to ${model.MAX_ISSUES} issues.`,"error");return;
    }
    issues.push({...issue,label:labelInput.value.trim().slice(0,120)});
    urlInput.value="";labelInput.value="";
    render();void save();message("Issue pinned.","success");
  }
  document.getElementById("add-pinned-issue").addEventListener("click",add);
  [urlInput,labelInput].forEach(input=>input.addEventListener("keydown",event=>{
    if(event.key!=="Enter")return;event.preventDefault();add();
  }));
  list.addEventListener("dragstart",event=>{
    const row=event.target.closest(".pinned-issue-setting");if(!row)return;
    dragged=row;row.classList.add("dragging");
    event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("text/plain",row.dataset.url);
  });
  list.addEventListener("dragover",event=>{
    const row=event.target.closest(".pinned-issue-setting");
    if(!dragged||!row||row===dragged)return;
    event.preventDefault();const rect=row.getBoundingClientRect();
    list.insertBefore(dragged,event.clientY>rect.top+rect.height/2?row.nextSibling:row);
  });
  list.addEventListener("drop",event=>event.preventDefault());
  list.addEventListener("dragend",()=>{
    if(!dragged)return;dragged.classList.remove("dragging");dragged=null;reorder();
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area!=="local"||!changes[KEY])return;
    issues=model.normalizePinnedIssues(changes[KEY].newValue);render();
  });
  chrome.storage.local.get({[KEY]:[]}).then(stored=>{
    issues=model.normalizePinnedIssues(stored[KEY]);render();
  }).catch(error=>message(error.message,"error"));
})();
