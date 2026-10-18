(() => {
  "use strict";
  const context=globalThis.__ghrcExtensionContext, model=globalThis.__ghrcPinnedIssues;
  if(context?.active()===false||!model)return;
  const WIDGET_ID="github-repositories-for-chatgpt",ID="ghrc-pinned-issues",KEY="pinnedIssues";
  let scheduled=false,revision=0;
  function makeLink(issue) {
    const a=document.createElement("a");a.className="ghrc-pinned-issue";
    a.href=issue.url;a.rel="noopener noreferrer";a.title=issue.url;
    const title=document.createElement("strong");title.textContent=issue.label||`${issue.repository} #${issue.number}`;
    const subtitle=document.createElement("small");subtitle.textContent=`${issue.owner}/${issue.repository} · #${issue.number}`;
    a.append(title,subtitle);return a;
  }
  function sync(widget,section) {
    for(const property of ["--ghrc-available-width","--ghrc-center-offset"]) {
      const value=widget.style.getPropertyValue(property);
      if(value)section.style.setProperty(property,value);
      else section.style.removeProperty(property);
    }
  }
  async function mount() {
    const sequence=++revision, widget=document.getElementById(WIDGET_ID);
    if(!widget){document.getElementById(ID)?.remove();return;}
    const stored=await chrome.storage.local.get({[KEY]:[]});
    if(sequence!==revision||!widget.isConnected||context?.active()===false)return;
    const issues=model.normalizePinnedIssues(stored[KEY]);
    document.getElementById(ID)?.remove();
    if(!issues.length)return;
    const section=document.createElement("section");section.id=ID;
    section.className="ghrc-pinned-issues";section.setAttribute("aria-label","Pinned issues");
    const title=document.createElement("h2");title.textContent="Pinned issues";
    const row=document.createElement("div");row.className="ghrc-pinned-issues-row";
    row.append(...issues.map(makeLink));section.append(title,row);
    sync(widget,section);
    (document.getElementById("ghrc-deep-research-dashboard")||widget).insertAdjacentElement("afterend",section);
  }
  function schedule() {
    if(scheduled||context?.active()===false)return;
    scheduled=true;requestAnimationFrame(()=>{
      scheduled=false;void mount().catch(error=>context?.handleError(error));
    });
  }
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==="local"&&changes[KEY])schedule();
  });
  const observer=new MutationObserver(mutations=>{
    const widget=document.getElementById(WIDGET_ID),section=document.getElementById(ID);
    if(!widget){section?.remove();return;}
    const anchor=document.getElementById("ghrc-deep-research-dashboard")||widget;
    if(section&&anchor.nextElementSibling===section){sync(widget,section);return;}
    if(mutations.some(m=>m.target===widget||
      [...m.addedNodes,...m.removedNodes].some(node=>node instanceof Element&&(
        [WIDGET_ID,ID,"ghrc-deep-research-dashboard"].includes(node.id)||
        Boolean(node.querySelector?.(`#${WIDGET_ID},#${ID},#ghrc-deep-research-dashboard`))
      ))))schedule();
  });
  context?.onStop(()=>observer.disconnect());
  observer.observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:["style"]});
  schedule();
})();
