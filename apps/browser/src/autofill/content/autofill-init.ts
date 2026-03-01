import { EVENTS } from "@bitwarden/common/autofill/constants";

import AutofillPageDetails from "../models/autofill-page-details";
import { AutofillInlineMenuContentService } from "../overlay/inline-menu/abstractions/autofill-inline-menu-content.service";
import { OverlayNotificationsContentService } from "../overlay/notifications/abstractions/overlay-notifications-content.service";
import { AutofillOverlayContentService } from "../services/abstractions/autofill-overlay-content.service";
import { DomElementVisibilityService } from "../services/abstractions/dom-element-visibility.service";
import { DomQueryService } from "../services/abstractions/dom-query.service";
import { SubmitLoginButtonNames } from "../services/autofill-constants";
import { CollectAutofillContentService } from "../services/collect-autofill-content.service";
import InsertAutofillContentService from "../services/insert-autofill-content.service";
import { sendExtensionMessage } from "../utils";

import {
  AutofillExtensionMessage,
  AutofillExtensionMessageHandlers,
  AutofillInit as AutofillInitInterface,
} from "./abstractions/autofill-init";

class AutofillInit implements AutofillInitInterface {
  private readonly sendExtensionMessage = sendExtensionMessage;
  private readonly collectAutofillContentService: CollectAutofillContentService;
  private readonly insertAutofillContentService: InsertAutofillContentService;
  private collectPageDetailsOnLoadTimeout: number | NodeJS.Timeout | undefined;
  private lastFilledElement: HTMLElement | null = null;
  private readonly extensionMessageHandlers: AutofillExtensionMessageHandlers = {
    collectPageDetails: ({ message }) => this.collectPageDetails(message),
    collectPageDetailsImmediately: ({ message }) => this.collectPageDetails(message, true),
    fillForm: ({ message }) => this.fillForm(message),
  };

  /**
   * AutofillInit constructor. Initializes the DomElementVisibilityService,
   * CollectAutofillContentService and InsertAutofillContentService classes.
   *
   * @param domQueryService - Service used to handle DOM queries.
   * @param domElementVisibilityService - Used to check if an element is viewable.
   * @param autofillOverlayContentService - The autofill overlay content service, potentially undefined.
   * @param autofillInlineMenuContentService - The inline menu content service, potentially undefined.
   * @param overlayNotificationsContentService - The overlay notifications content service, potentially undefined.
   */
  constructor(
    domQueryService: DomQueryService,
    domElementVisibilityService: DomElementVisibilityService,
    private autofillOverlayContentService?: AutofillOverlayContentService,
    private autofillInlineMenuContentService?: AutofillInlineMenuContentService,
    private overlayNotificationsContentService?: OverlayNotificationsContentService,
  ) {
    this.collectAutofillContentService = new CollectAutofillContentService(
      domElementVisibilityService,
      domQueryService,
      this.autofillOverlayContentService,
    );
    this.insertAutofillContentService = new InsertAutofillContentService(
      domElementVisibilityService,
      this.collectAutofillContentService,
    );
  }

  /**
   * Initializes the autofill content script, setting up
   * the extension message listeners. This method should
   * be called once when the content script is loaded.
   */
  init() {
    this.setupExtensionMessageListeners();
    this.autofillOverlayContentService?.init();
    this.collectPageDetailsOnLoad();
  }

  /**
   * Triggers a collection of the page details from the
   * background script, ensuring that autofill is ready
   * to act on the page.
   */
  private collectPageDetailsOnLoad() {
    if (globalThis.document.readyState === "complete") {
      this.sendCollectDetailsMessage();
    }

    globalThis.addEventListener(EVENTS.LOAD, this.sendCollectDetailsMessage);
  }

  /**
   * Sends a message to collect page details after a short delay.
   */
  private sendCollectDetailsMessage = () => {
    this.clearCollectPageDetailsOnLoadTimeout();
    this.collectPageDetailsOnLoadTimeout = setTimeout(
      () => this.sendExtensionMessage("bgCollectPageDetails", { sender: "autofillInit" }),
      750,
    );
  };

  /**
   * Collects the page details and sends them to the
   * extension background script. If the `sendDetailsInResponse`
   * parameter is set to true, the page details will be
   * returned to facilitate sending the details in the
   * response to the extension message.
   *
   * @param message - The extension message.
   * @param sendDetailsInResponse - Determines whether to send the details in the response.
   */
  private async collectPageDetails(
    message: AutofillExtensionMessage,
    sendDetailsInResponse = false,
  ): Promise<AutofillPageDetails | void> {
    const pageDetails: AutofillPageDetails =
      await this.collectAutofillContentService.getPageDetails();
    if (sendDetailsInResponse) {
      return pageDetails;
    }

    void this.sendExtensionMessage("collectPageDetailsResponse", {
      tab: message.tab,
      details: pageDetails,
      sender: message.sender,
    });
  }

  /**
   * Fills the form with the given fill script.
   *
   * @param {AutofillExtensionMessage} message
   */
  private async fillForm({
    fillScript,
    pageDetailsUrl,
    autoSubmitAfterFill,
  }: AutofillExtensionMessage) {
    if ((document.defaultView || window).location.href !== pageDetailsUrl || !fillScript) {
      return;
    }

    this.blurFocusedFieldAndCloseInlineMenu();
    await this.sendExtensionMessage("updateIsFieldCurrentlyFilling", {
      isFieldCurrentlyFilling: true,
    });
    await this.insertAutofillContentService.fillForm(fillScript);

    // Gefülltes Element merken — activeElement ist nach dem Fill idealerweise das letzte Feld.
    // Falls activeElement body ist (z.B. nach Blur), Fallback über gefüllte Passwort-Felder.
    const activeEl = document.activeElement as HTMLElement;
    if (activeEl && activeEl !== document.body) {
      this.lastFilledElement = activeEl;
    } else {
      // Fallback: letztes sichtbares Passwort- oder Text-Input mit Wert finden
      const filledInputs = document.querySelectorAll<HTMLInputElement>(
        "input[type='password'], input[type='text'], input[type='email']",
      );
      const lastFilled = Array.from(filledInputs)
        .reverse()
        .find((el) => el.value && this.isElementVisible(el));
      this.lastFilledElement = lastFilled || activeEl;
    }

    setTimeout(
      () =>
        this.sendExtensionMessage("updateIsFieldCurrentlyFilling", {
          isFieldCurrentlyFilling: false,
        }),
      250,
    );

    // Nach dem Füllen automatisch absenden, wenn aktiviert
    // eslint-disable-next-line no-console
    console.log(
      "[BW-DEBUG] fillForm fertig, autoSubmitAfterFill:",
      autoSubmitAfterFill,
      "lastFilledElement:",
      this.lastFilledElement?.tagName,
      this.lastFilledElement?.getAttribute("type"),
    );
    if (autoSubmitAfterFill) {
      setTimeout(() => this.trySubmitForm(), 500);
    }
  }

  /**
   * Versucht das Formular abzusenden mit Retry-Mechanismus.
   * Manche Seiten brauchen Zeit bis der Submit-Button enabled wird
   * (z.B. Backend-Healthcheck, async Validierung). Wir prüfen alle 500ms
   * ob ein klickbarer Button vorhanden ist (max 3 Sekunden).
   */
  private trySubmitForm(attempt = 0) {
    const maxAttempts = 6; // 6 × 500ms = 3 Sekunden
    if (attempt > maxAttempts) {
      // eslint-disable-next-line no-console
      console.log("[BW-DEBUG] trySubmitForm: max Versuche erreicht, aufgegeben");
      return;
    }

    // eslint-disable-next-line no-console
    console.log("[BW-DEBUG] trySubmitForm Versuch", attempt);
    const clicked = this.findAndClickSubmitButton();
    // eslint-disable-next-line no-console
    console.log("[BW-DEBUG] trySubmitForm Versuch", attempt, "→ geklickt:", clicked);
    if (!clicked && attempt < maxAttempts) {
      setTimeout(() => this.trySubmitForm(attempt + 1), 500);
    }
  }

  /**
   * Sucht einen Submit-Button und klickt ihn.
   * Gibt true zurück wenn ein Button gefunden und geklickt wurde.
   *
   * Strategie-Reihenfolge:
   * 1. Enabled Submit-Button im Formular
   * 2. Klickbare Elemente mit Submit-Keywords (ExtJS, Custom UIs)
   * 3. cursor:pointer Elemente nahe dem gefüllten Feld
   */
  private findAndClickSubmitButton(): boolean {
    const filledEl = this.lastFilledElement;
    const form = filledEl?.closest("form") as HTMLFormElement;

    // eslint-disable-next-line no-console
    console.log(
      "[BW-DEBUG] findAndClick: filledEl:",
      filledEl?.tagName,
      "form:",
      !!form,
      "form.action:",
      form?.action,
    );

    // 1. Enabled Submit-Button im Formular (oder global)
    const submitSelector =
      "button[type='submit']:not([disabled]), input[type='submit']:not([disabled])";
    const submitBtn =
      form?.querySelector<HTMLElement>(submitSelector) ||
      document.querySelector<HTMLElement>(submitSelector);

    // Auch disabled Buttons loggen
    const disabledBtn = form?.querySelector<HTMLElement>(
      "button[type='submit'][disabled], input[type='submit'][disabled]",
    );
    // eslint-disable-next-line no-console
    console.log(
      "[BW-DEBUG] findAndClick: enabledSubmitBtn:",
      submitBtn?.tagName,
      submitBtn?.textContent?.trim(),
      "disabledSubmitBtn:",
      disabledBtn?.tagName,
      disabledBtn?.textContent?.trim(),
    );

    if (submitBtn && this.isElementVisible(submitBtn)) {
      // eslint-disable-next-line no-console
      console.log("[BW-DEBUG] → Strategie 1: Klicke enabled Submit-Button");
      this.simulateFullClick(submitBtn);
      return true;
    }

    // 2. Klickbare Elemente mit Submit-Keywords (ExtJS Buttons, ARIA, Links)
    // Aber: <a>-Elemente mit echtem href (Navigation) ausschließen — nur role="button" zählt
    const clickableSelector =
      "button:not([disabled]), [role='button'], " +
      "a[class*='btn'], a[class*='button'], " +
      "span[class*='btn'], div[class*='btn']";
    const allClickables = document.querySelectorAll<HTMLElement>(clickableSelector);
    // eslint-disable-next-line no-console
    console.log("[BW-DEBUG] findAndClick: clickable Elemente:", allClickables.length);
    for (const el of Array.from(allClickables)) {
      // <a>-Elemente mit echtem href überspringen (sind Navigations-Links, keine Buttons)
      // Ausnahme: role="button" (z.B. ExtJS Buttons wie bei Proxmox)
      if (el.tagName === "A" && this.isNavigationLink(el as HTMLAnchorElement)) {
        continue;
      }
      const isSubmit = this.isSubmitElement(el);
      const isVisible = this.isElementVisible(el);
      if (isSubmit) {
        // eslint-disable-next-line no-console
        console.log(
          "[BW-DEBUG]   Kandidat:",
          el.tagName,
          el.textContent?.trim()?.substring(0, 30),
          "visible:",
          isVisible,
          "class:",
          el.className?.toString()?.substring(0, 50),
        );
      }
      if (isSubmit && isVisible) {
        // eslint-disable-next-line no-console
        console.log(
          "[BW-DEBUG] → Strategie 2: Klicke Keyword-Element:",
          el.tagName,
          el.textContent?.trim(),
        );
        this.simulateFullClick(el);
        return true;
      }
    }

    // 3. cursor:pointer Elemente nahe dem gefüllten Feld — NUR mit Submit-Keywords!
    // Ohne Keywords werden sonst Sidebar-Buttons, Nav-Links etc. geklickt.
    if (filledEl && filledEl !== document.body) {
      const pointerEl = this.findNearestSubmitPointerElement(filledEl);
      if (pointerEl) {
        // eslint-disable-next-line no-console
        console.log(
          "[BW-DEBUG] → Strategie 3: Klicke Pointer-Element:",
          pointerEl.tagName,
          pointerEl.textContent?.trim(),
        );
        this.simulateFullClick(pointerEl);
        return true;
      }
    }

    // eslint-disable-next-line no-console
    console.log("[BW-DEBUG] findAndClick: KEIN Button gefunden");
    return false;
  }

  /**
   * Simuliert einen vollständigen Mausklick (mousedown → mouseup → click).
   * Wichtig: element.click() statt dispatchEvent für den Click, damit die
   * Browser-Default-Action ausgelöst wird (z.B. Form-Submission bei Submit-Buttons).
   */
  private simulateFullClick(element: HTMLElement) {
    const eventInit: MouseEventInit = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.click();
  }

  /**
   * Prüft ob ein Element ein Submit-/Login-Button ist.
   */
  private isSubmitElement(element: HTMLElement): boolean {
    const searchText = this.getElementSearchText(element);
    return SubmitLoginButtonNames.some((keyword) => searchText.includes(keyword));
  }

  /**
   * Prüft ob ein Element ein Cancel/Reset-Button ist.
   */
  private isResetOrCancelButton(element: HTMLElement): boolean {
    const searchText = this.getElementSearchText(element);
    const cancelKeywords = [
      "cancel",
      "reset",
      "abbrechen",
      "zurück",
      "back",
      "close",
      "schließen",
      "clear",
      "dismiss",
    ];
    return cancelKeywords.some((kw) => searchText.includes(kw));
  }

  /**
   * Sammelt durchsuchbaren Text eines Elements.
   * Nur semantische Attribute (sichtbarer Text, ARIA, etc.) — KEINE CSS-Klassen,
   * da diese nach Normalisierung Falschmeldungen erzeugen (z.B. "fa-book" → "fabook" enthält "ok").
   */
  private getElementSearchText(element: HTMLElement): string {
    return [
      element.textContent?.trim(),
      element.getAttribute("value"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("id"),
      element.getAttribute("name"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .replace(/[-_\s]+/g, "");
  }

  /**
   * Prüft ob ein <a>-Element ein Navigations-Link ist (hat echten href,
   * ist kein role="button"). Solche Links sollen nicht als Submit-Button geklickt werden.
   */
  private isNavigationLink(element: HTMLAnchorElement): boolean {
    if (element.getAttribute("role") === "button") {
      return false; // ExtJS-Pattern: <a role="button"> ohne href
    }
    const href = element.getAttribute("href");
    if (!href || href === "#" || href.startsWith("javascript:")) {
      return false; // Kein echter Navigations-Link
    }
    return true; // Echte Navigation → nicht als Submit-Button verwenden
  }

  /**
   * Findet das nächste klickbare Element (cursor:pointer) mit Submit-Keywords
   * in der Nähe des Referenz-Elements. Nur Elemente mit expliziten Submit-Keywords
   * werden berücksichtigt, um versehentliches Klicken von Sidebar-Buttons,
   * Navigations-Links etc. zu vermeiden.
   */
  private findNearestSubmitPointerElement(reference: HTMLElement): HTMLElement | null {
    const refRect = reference.getBoundingClientRect();
    let closest: HTMLElement | null = null;
    let minDistance = Infinity;

    const candidates = document.querySelectorAll<HTMLElement>("*");
    for (const el of Array.from(candidates)) {
      if (el.contains(reference) || el === reference) {
        continue;
      }
      if (el.querySelector("input, select, textarea")) {
        continue;
      }
      // <a>-Links mit echtem href überspringen
      if (el.tagName === "A" && this.isNavigationLink(el as HTMLAnchorElement)) {
        continue;
      }

      const style = globalThis.getComputedStyle(el);
      if (style.cursor !== "pointer") {
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20 || rect.width > 500) {
        continue;
      }
      if (!this.isElementVisible(el)) {
        continue;
      }
      if (this.isResetOrCancelButton(el)) {
        continue;
      }

      // NUR Elemente mit Submit-Keywords — kein Fallback auf "kurzer Text"
      if (!this.isSubmitElement(el)) {
        continue;
      }

      const distance = Math.sqrt(
        Math.pow(rect.left - refRect.left, 2) + Math.pow(rect.top - refRect.top, 2),
      );
      if (distance < minDistance) {
        minDistance = distance;
        closest = el;
      }
    }
    return closest;
  }

  /**
   * Prüft ob ein Element sichtbar ist.
   */
  private isElementVisible(element: HTMLElement): boolean {
    if (!element) {
      return false;
    }
    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  /**
   * Blurs the most recently focused field and removes the inline menu. Used
   * in cases where the background unlock or vault item reprompt popout
   * is opened.
   */
  private blurFocusedFieldAndCloseInlineMenu() {
    this.autofillOverlayContentService?.blurMostRecentlyFocusedField(true);
  }

  /**
   * Clears the send collect details message timeout.
   */
  private clearCollectPageDetailsOnLoadTimeout() {
    if (this.collectPageDetailsOnLoadTimeout) {
      clearTimeout(this.collectPageDetailsOnLoadTimeout);
    }
  }

  /**
   * Sets up the extension message listeners for the content script.
   */
  private setupExtensionMessageListeners() {
    chrome.runtime.onMessage.addListener(this.handleExtensionMessage);
  }

  /**
   * Handles the extension messages sent to the content script.
   *
   * @param message - The extension message.
   * @param sender - The message sender.
   * @param sendResponse - The send response callback.
   */
  private handleExtensionMessage = (
    message: AutofillExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ): boolean | null => {
    const command: string = message.command;
    const handler: CallableFunction | undefined = this.getExtensionMessageHandler(command);
    if (!handler) {
      return null;
    }

    const messageResponse = handler({ message, sender });
    if (typeof messageResponse === "undefined") {
      return null;
    }

    void Promise.resolve(messageResponse).then((response) => sendResponse(response));
    return true;
  };

  /**
   * Gets the extension message handler for the given command.
   *
   * @param command - The extension message command.
   */
  private getExtensionMessageHandler(command: string): CallableFunction | undefined {
    if (this.autofillOverlayContentService?.messageHandlers?.[command]) {
      return this.autofillOverlayContentService.messageHandlers[command];
    }

    if (this.autofillInlineMenuContentService?.messageHandlers?.[command]) {
      return this.autofillInlineMenuContentService.messageHandlers[command];
    }

    if (this.overlayNotificationsContentService?.messageHandlers?.[command]) {
      return this.overlayNotificationsContentService.messageHandlers[command];
    }

    return this.extensionMessageHandlers[command];
  }

  /**
   * Handles destroying the autofill init content script. Removes all
   * listeners, timeouts, and object instances to prevent memory leaks.
   */
  destroy() {
    this.clearCollectPageDetailsOnLoadTimeout();
    globalThis.removeEventListener(EVENTS.LOAD, this.sendCollectDetailsMessage);
    chrome.runtime.onMessage.removeListener(this.handleExtensionMessage);
    this.collectAutofillContentService.destroy();
    this.autofillOverlayContentService?.destroy();
    this.autofillInlineMenuContentService?.destroy();
    this.overlayNotificationsContentService?.destroy();
  }
}

export default AutofillInit;
