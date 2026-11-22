let supportsDisplayTransition: boolean | undefined;

/**
 * Probes whether discrete `display` transitions actually hold visibility during exit.
 * Avoids relying solely on `CSS.supports('transition-behavior', 'allow-discrete')`
 * because Firefox 129+ parses the property without transitioning `display`.
 */
export function canTransitionDisplay(): boolean {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (
    typeof window === "undefined" ||
    !window.CSS?.supports?.("transition-behavior", "allow-discrete") ||
    !document.body
  ) {
    return false;
  }

  const probe = document.createElement("div");
  probe.style.cssText =
    "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = "none";
  supportsDisplayTransition = getComputedStyle(probe).display === "block";
  probe.remove();
  return supportsDisplayTransition;
}

export function supportsTopLayerExit(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.CSS?.supports?.("overlay", "auto") && canTransitionDisplay()
  );
}

export async function closeModalDialog(
  dialog: HTMLDialogElement | null
): Promise<void> {
  if (!dialog || !dialog.open) return;

  if (!supportsTopLayerExit()) {
    dialog.setAttribute("data-closing", "");
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise<void>((resolve) => setTimeout(resolve, 400)),
      ]);
    }
    if (!dialog.hasAttribute("data-closing")) return;
    dialog.removeAttribute("data-closing");
  }

  if (dialog.open) {
    dialog.close();
  }
}

/**
 * Attaches light-dismiss fallback for runtimes without native `<dialog closedby="any">`
 * and animates cancel requests when native top-layer exit transitions are absent.
 */
export function bindDialogLightDismiss(
  dialog: HTMLDialogElement,
  onClosed: () => void
): () => void {
  const handleClose = () => {
    dialog.removeAttribute("data-closing");
    onClosed();
  };

  const handleCancel = (event: Event) => {
    if (!supportsTopLayerExit()) {
      event.preventDefault();
      void closeModalDialog(dialog);
    }
  };

  const handleClickFallback = (event: MouseEvent) => {
    if ("closedBy" in HTMLDialogElement.prototype) return;
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const insideContent =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (insideContent) return;
    void closeModalDialog(dialog);
  };

  dialog.addEventListener("close", handleClose);
  dialog.addEventListener("cancel", handleCancel);
  dialog.addEventListener("click", handleClickFallback);

  return () => {
    dialog.removeEventListener("close", handleClose);
    dialog.removeEventListener("cancel", handleCancel);
    dialog.removeEventListener("click", handleClickFallback);
  };
}
