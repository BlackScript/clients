// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { BrowserApi } from "../../../platform/browser/browser-api";
import BrowserPopupUtils from "../../../platform/browser/browser-popup-utils";

const AuthPopoutType = {
  unlockExtension: "auth_unlockExtension",
  ssoAuthResult: "auth_ssoAuthResult",
  twoFactorAuthWebAuthn: "auth_twoFactorAuthWebAuthn",
  twoFactorAuthEmail: "auth_twoFactorAuthEmail",
  twoFactorAuthDuo: "auth_twoFactorAuthDuo",
} as const;

const extensionUnlockUrls = new Set([
  chrome.runtime.getURL("popup/index.html#/lock"),
  chrome.runtime.getURL("popup/index.html#/login"),
]);

/**
 * Opens a window that facilitates unlocking / logging into the extension.
 *
 * Versucht zuerst das native Extension-Popup zu öffnen (chrome.action.openPopup),
 * das direkt am Browser-Icon erscheint — sauberer als ein separates Fenster.
 * Fallback auf Popout-Fenster wenn die API nicht verfügbar ist (Firefox, ältere Chrome).
 *
 * @param senderTab - Used to determine the windowId of the sender.
 */
async function openUnlockPopout(senderTab: chrome.tabs.Tab) {
  // Bestehende Unlock-Popouts aufräumen
  const existingPopoutWindowTabs = await BrowserApi.tabsQuery({ windowType: "popup" });
  existingPopoutWindowTabs.forEach((tab) => {
    if (extensionUnlockUrls.has(tab.url)) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      BrowserApi.removeWindow(tab.windowId);
    }
  });

  // Versuch 1: Natives Extension-Popup öffnen (Chrome 127+, MV3)
  // Öffnet das Popup direkt am Extension-Icon — kein separates Fenster nötig.
  const browserAction = BrowserApi.getBrowserAction();
  if ("openPopup" in browserAction && typeof browserAction.openPopup === "function") {
    try {
      await browserAction.openPopup();
      await BrowserApi.tabSendMessageData(senderTab, "bgUnlockPopoutOpened", {});
      return;
    } catch {
      // openPopup kann fehlschlagen wenn z.B. kein aktives Fenster existiert
    }
  }

  // Fallback: Separates Popout-Fenster öffnen
  await BrowserPopupUtils.openPopout("popup/index.html", {
    singleActionKey: AuthPopoutType.unlockExtension,
    senderWindowId: senderTab.windowId,
  });
  await BrowserApi.tabSendMessageData(senderTab, "bgUnlockPopoutOpened", {});
}

/**
 * Closes the unlock popout window.
 */
async function closeUnlockPopout() {
  await BrowserPopupUtils.closeSingleActionPopout(AuthPopoutType.unlockExtension);
}

/**
 * Opens a window that facilitates presenting the results for SSO authentication.
 *
 * @param resultData - The result data from the SSO authentication.
 */
async function openSsoAuthResultPopout(resultData: { code: string; state: string }) {
  const { code, state } = resultData;
  const authResultUrl = `popup/index.html#/sso?code=${encodeURIComponent(
    code,
  )}&state=${encodeURIComponent(state)}`;

  await BrowserPopupUtils.openPopout(authResultUrl, {
    singleActionKey: AuthPopoutType.ssoAuthResult,
  });
}

/**
 * Closes the SSO authentication result popout window.
 */
async function closeSsoAuthResultPopout() {
  await BrowserPopupUtils.closeSingleActionPopout(AuthPopoutType.ssoAuthResult);
}

/**
 * Opens a popout that facilitates two-factor authentication via WebAuthn.
 *
 * @param twoFactorAuthWebAuthnData - The data to send ot the popout via query param.
 * It includes the WebAuthn response and whether to save the 2FA remember me token or not.
 */
async function openTwoFactorAuthWebAuthnPopout(twoFactorAuthWebAuthnData: {
  data: string;
  remember: string;
}) {
  const { data, remember } = twoFactorAuthWebAuthnData;
  const params =
    `webAuthnResponse=${encodeURIComponent(data)};` + `remember=${encodeURIComponent(remember)}`;
  const twoFactorUrl = `popup/index.html#/2fa;${params}`;

  await BrowserPopupUtils.openPopout(twoFactorUrl, {
    singleActionKey: AuthPopoutType.twoFactorAuthWebAuthn,
  });
}

/**
 * Closes the two-factor authentication WebAuthn popout window.
 */
async function closeTwoFactorAuthWebAuthnPopout() {
  await BrowserPopupUtils.closeSingleActionPopout(AuthPopoutType.twoFactorAuthWebAuthn);
}

/**
 * Opens a popout that facilitates two-factor authentication via email.
 */
async function openTwoFactorAuthEmailPopout() {
  await BrowserPopupUtils.openPopout("popup/index.html#/2fa", {
    singleActionKey: AuthPopoutType.twoFactorAuthEmail,
  });
}

/**
 * Closes the two-factor authentication email popout window.
 */
async function closeTwoFactorAuthEmailPopout() {
  await BrowserPopupUtils.closeSingleActionPopout(AuthPopoutType.twoFactorAuthEmail);
}

/**
 * Opens the two-factor authentication Duo popout.
 */
async function openTwoFactorAuthDuoPopout() {
  await BrowserPopupUtils.openPopout("popup/index.html#/2fa", {
    singleActionKey: AuthPopoutType.twoFactorAuthDuo,
  });
}

/**
 * Closes the two-factor authentication Duo popout.
 */
async function closeTwoFactorAuthDuoPopout() {
  await BrowserPopupUtils.closeSingleActionPopout(AuthPopoutType.twoFactorAuthDuo);
}

export {
  AuthPopoutType,
  openUnlockPopout,
  closeUnlockPopout,
  openSsoAuthResultPopout,
  closeSsoAuthResultPopout,
  openTwoFactorAuthWebAuthnPopout,
  closeTwoFactorAuthWebAuthnPopout,
  openTwoFactorAuthEmailPopout,
  closeTwoFactorAuthEmailPopout,
  openTwoFactorAuthDuoPopout,
  closeTwoFactorAuthDuoPopout,
};
