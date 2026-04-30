const responses = [
  "Merhaba! Size nasıl yardımcı olabilirim?",
  "Bu ilginç bir soru! Biraz düşünmem gerekiyor... Şaka şaka, ben dummy bir botum. 🤖",
  "Harika bir gün değil mi? En azından benim için her gün aynı. 😄",
  "Bunu duyduğuma sevindim! Başka bir şey sormak ister misiniz?",
  "Hmm, bu konuda kesin bir şey söyleyemem ama elimden geleni yapıyorum!",
  "Teşekkürler! Sizinle sohbet etmek çok keyifli.",
  "Bu soruyu daha önce hiç duymamıştım. Ama yine de bir cevap vereyim: 42. 🎯",
  "Anlıyorum. Devam edin, sizi dinliyorum!",
  "Vay canına! Bu gerçekten düşündürücü bir konu.",
  "Ben bir yapay zeka chatbot'uyum. Şimdilik dummy yanıtlar veriyorum ama yakında gerçek bir AI entegrasyonu gelecek!",
];

export function getDummyResponse(): string {
  const index = Math.floor(Math.random() * responses.length);
  return responses[index];
}
