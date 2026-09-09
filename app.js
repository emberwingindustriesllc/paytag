const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL
} = solanaWeb3;


// --------------------------------------------------
// SETTINGS
// --------------------------------------------------

const NETWORK = "devnet";

const connection = new Connection(
  "https://api.devnet.solana.com",
  "confirmed"
);


// --------------------------------------------------
// ELEMENTS
// --------------------------------------------------

const connectButton =
  document.getElementById("connectButton");

const walletDisconnected =
  document.getElementById("walletDisconnected");

const walletConnected =
  document.getElementById("walletConnected");

const status =
  document.getElementById("status");

const usernameInput =
  document.getElementById("username");

const saveButton =
  document.getElementById("saveButton");

const paytagResult =
  document.getElementById("paytagResult");

const paytagUrl =
  document.getElementById("paytagUrl");

const copyButton =
  document.getElementById("copyButton");

const paymentSection =
  document.getElementById("paymentSection");

const sendButton =
  document.getElementById("sendButton");

const customAmount =
  document.getElementById("customAmount");

const paymentStatus =
  document.getElementById("paymentStatus");


// --------------------------------------------------
// WALLET
// --------------------------------------------------

let walletPublicKey = null;
let recipientWallet = null;


// Detect Phantom / Solana wallet

function getWallet() {

  if ("solana" in window) {

    const wallet = window.solana;

    if (wallet.isPhantom) {
      return wallet;
    }

  }

  return null;
}


// --------------------------------------------------
// CONNECT WALLET
// --------------------------------------------------

connectButton.addEventListener(
  "click",
  async () => {

    const wallet = getWallet();

    if (!wallet) {

      status.textContent =
        "No compatible Solana wallet found. Install Phantom first.";

      return;
    }

    try {

      status.textContent =
        "Connecting...";

      const response =
        await wallet.connect();

      walletPublicKey =
        response.publicKey;

      status.textContent = "";

      walletDisconnected.classList.add(
        "hidden"
      );

      walletConnected.classList.remove(
        "hidden"
      );

      paymentSection.classList.remove(
        "hidden"
      );

    } catch (error) {

      console.error(error);

      status.textContent =
        "Wallet connection was cancelled.";

    }

  }
);


// --------------------------------------------------
// CREATE PAYTAG
// --------------------------------------------------

saveButton.addEventListener(
  "click",
  () => {

    if (!walletPublicKey) {

      return;

    }

    let username =
      usernameInput.value.trim().toLowerCase();

    username =
      username.replace(
        /[^a-z0-9_-]/g,
        ""
      );

    if (!username) {

      alert(
        "Please enter a username."
      );

      return;

    }

    const url =
      `${window.location.origin}/?user=${username}&wallet=${walletPublicKey.toString()}`;

    paytagUrl.textContent = url;

    paytagResult.classList.remove(
      "hidden"
    );

  }
);


// --------------------------------------------------
// COPY PAYMENT LINK
// --------------------------------------------------

copyButton.addEventListener(
  "click",
  async () => {

    await navigator.clipboard.writeText(
      paytagUrl.textContent
    );

    copyButton.textContent =
      "Copied!";

    setTimeout(
      () => {

        copyButton.textContent =
          "Copy Payment Link";

      },
      2000
    );

  }
);


// --------------------------------------------------
// PRESET AMOUNTS
// --------------------------------------------------

document
  .querySelectorAll(".amount-button")
  .forEach(button => {

    button.addEventListener(
      "click",
      () => {

        customAmount.value =
          button.dataset.amount;

      }
    );

  });


// --------------------------------------------------
// SEND SOL
// --------------------------------------------------

sendButton.addEventListener(
  "click",
  async () => {

    paymentStatus.textContent =
      "";

    const wallet =
      getWallet();

    if (!wallet) {

      paymentStatus.textContent =
        "Please connect a Solana wallet.";

      return;

    }

    const amount =
      parseFloat(
        customAmount.value
      );

    if (
      !amount ||
      amount <= 0
    ) {

      paymentStatus.textContent =
        "Enter a valid amount.";

      return;

    }


    // Get recipient from URL

    const params =
      new URLSearchParams(
        window.location.search
      );

    const recipientAddress =
      params.get("wallet");


    if (!recipientAddress) {

      paymentStatus.textContent =
        "No recipient wallet was found.";

      return;

    }


    try {

      sendButton.disabled =
        true;

      sendButton.textContent =
        "Preparing transaction...";


      const recipient =
        new PublicKey(
          recipientAddress
        );


      // Convert SOL → lamports

      const lamports =
        Math.round(
          amount *
          LAMPORTS_PER_SOL
        );


      // Create transaction

      const transaction =
        new Transaction().add(

          SystemProgram.transfer({

            fromPubkey:
              walletPublicKey,

            toPubkey:
              recipient,

            lamports:
              lamports

          })

        );


      // Get recent blockhash

      const {
        blockhash
      } =
        await connection.getLatestBlockhash();


      transaction.recentBlockhash =
        blockhash;

      transaction.feePayer =
        walletPublicKey;


      sendButton.textContent =
        "Approve in wallet...";


      // Ask wallet to sign

      const signed =
        await wallet.signTransaction(
          transaction
        );


      sendButton.textContent =
        "Sending...";


      const signature =
        await connection.sendRawTransaction(
          signed.serialize()
        );


      await connection.confirmTransaction(
        signature,
        "confirmed"
      );


      paymentStatus.innerHTML =
        `
        Payment successful!<br>
        <a
          href="https://solscan.io/tx/${signature}"
          target="_blank"
        >
          View transaction
        </a>
        `;


    } catch (error) {

      console.error(error);

      paymentStatus.textContent =
        "Payment cancelled or failed.";

    }


    sendButton.disabled =
      false;

    sendButton.textContent =
      "Send SOL";

  }
);


// --------------------------------------------------
// LOAD EXISTING PAYTAG
// --------------------------------------------------

function loadPayTag() {

  const params =
    new URLSearchParams(
      window.location.search
    );

  const username =
    params.get("user");

  const wallet =
    params.get("wallet");

  if (username && wallet) {

    recipientWallet = wallet;

    walletDisconnected.classList.add(
      "hidden"
    );

    walletConnected.classList.add(
      "hidden"
    );

    paymentSection.classList.remove(
      "hidden"
    );

    document.getElementById(
      "recipientName"
    ).textContent =
      `Pay @${username}`;

  }

}
// --------------------------------------------------
// PAYMENT WALLET CONNECTION
// --------------------------------------------------

const paymentConnectButton =
  document.getElementById(
    "paymentConnectButton"
  );

const paymentForm =
  document.getElementById(
    "paymentForm"
  );


paymentConnectButton.addEventListener(
  "click",
  async () => {

    const wallet =
      getWallet();

    if (!wallet) {

      paymentStatus.textContent =
        "Please install a Solana wallet such as Phantom.";

      return;

    }

    try {

      const response =
        await wallet.connect();

      walletPublicKey =
        response.publicKey;

      paymentConnectButton.textContent =
        "Wallet connected";

      paymentConnectButton.disabled =
        true;

      paymentForm.classList.remove(
        "hidden"
      );

    } catch (error) {

      console.error(error);

      paymentStatus.textContent =
        "Wallet connection was cancelled.";

    }

  }
);
loadPayTag();
