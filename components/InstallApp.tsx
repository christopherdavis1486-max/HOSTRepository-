"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallApp() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)");
    const appleStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
    setInstalled(standalone.matches || appleStandalone === true);
    setIsIos(/iPad|iPhone|iPod/.test(navigator.userAgent));

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
      setInstructions(false);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  async function install() {
    if (!promptEvent) {
      setInstructions((visible) => !visible);
      return;
    }
    setPromptEvent(null);
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === "dismissed") setInstructions(true);
    } catch {
      setInstructions(true);
    }
  }

  return (
    <div className="host-install">
      <style>{`
        .host-install { max-width: 540px; margin: 26px auto 0; color: var(--ivory); }
        .host-install button { padding: 10px 18px; border: 1px solid var(--brass); border-radius: 4px; background: transparent; color: var(--ivory); font: inherit; font-size: 14px; cursor: pointer; }
        .host-install button:hover { background: var(--stone); }
        .host-install button:focus-visible { outline: 2px solid var(--brass); outline-offset: 3px; }
        .host-install p { margin: 12px 0 0; font-size: 13px; line-height: 1.5; color: var(--warm-grey); }
        .host-install .install-steps { padding: 14px 18px; border: 1px solid var(--stone); border-radius: 6px; text-align: left; }
      `}</style>
      <button type="button" onClick={install} aria-expanded={instructions} aria-controls="host-install-steps">
        <Image src="/icon-192.png" width={38} height={38} alt="" unoptimized style={{ verticalAlign: "middle", marginRight: 10, borderRadius: 7 }} />
        <span>Install HOST on iPhone or Android</span>
      </button>
      {instructions && (
        <p id="host-install-steps" className="install-steps" role="status">
          {isIos
            ? "On iPhone, open this page in Safari, tap Share, then Add to Home Screen and Add."
            : "On Android, open this page in Chrome, open the browser menu, then choose Install app or Add to Home screen. On a computer, open hostcityliving.com on your phone first."}
        </p>
      )}
    </div>
  );
}
