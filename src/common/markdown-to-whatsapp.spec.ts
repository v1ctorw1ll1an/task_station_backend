import { markdownToWhatsapp, balanceWhatsappEmphasis } from './markdown-to-whatsapp';

describe('markdownToWhatsapp', () => {
  it('converte negrito ** e __ para *', () => {
    expect(markdownToWhatsapp('**negrito**')).toBe('*negrito*');
    expect(markdownToWhatsapp('__negrito__')).toBe('*negrito*');
  });

  it('converte itálico * para _ e mantém _', () => {
    expect(markdownToWhatsapp('*itálico*')).toBe('_itálico_');
    expect(markdownToWhatsapp('_itálico_')).toBe('_itálico_');
  });

  it('não confunde negrito com itálico quando há os dois', () => {
    expect(markdownToWhatsapp('**bold** e *ital*')).toBe('*bold* e _ital_');
  });

  it('converte riscado ~~ para ~', () => {
    expect(markdownToWhatsapp('~~risc~~')).toBe('~risc~');
  });

  it('converte títulos em negrito', () => {
    expect(markdownToWhatsapp('# Título')).toBe('*Título*');
    expect(markdownToWhatsapp('### Sub')).toBe('*Sub*');
  });

  it('converte links e remove imagens', () => {
    expect(markdownToWhatsapp('[texto](http://x.com)')).toBe('texto (http://x.com)');
    expect(markdownToWhatsapp('![alt](http://img.png)')).toBe('alt');
  });

  it('converte listas em bullets •', () => {
    expect(markdownToWhatsapp('- item')).toBe('• item');
    expect(markdownToWhatsapp('* item')).toBe('• item');
    expect(markdownToWhatsapp('+ item')).toBe('• item');
  });

  it('remove crases de código inline e blocos', () => {
    expect(markdownToWhatsapp('`code`')).toBe('code');
    expect(markdownToWhatsapp('```js\nconst a = 1;\n```')).toBe('const a = 1;\n');
  });

  it('remove citação e regra horizontal', () => {
    expect(markdownToWhatsapp('> citação')).toBe('citação');
    expect(markdownToWhatsapp('---')).toBe('');
  });

  it('lida com descrição multilinha realista', () => {
    const md = '## Plano\n\nFazer **deploy** e _testes_.\nVer [doc](http://d.io)';
    expect(markdownToWhatsapp(md)).toBe(
      '*Plano*\n\nFazer *deploy* e _testes_.\nVer doc (http://d.io)',
    );
  });

  it('não deixa sentinela de controle vazar', () => {
    const out = markdownToWhatsapp('**a** **b** *c*');
    expect(out).toBe('*a* *b* _c_');
    // Garante que nenhum caractere de controle (sentinela do negrito) sobrou.
    expect([...out].some((ch) => ch.charCodeAt(0) < 32 && ch !== '\n')).toBe(false);
  });

  it('retorna vazio para entrada vazia', () => {
    expect(markdownToWhatsapp('')).toBe('');
  });
});

describe('balanceWhatsappEmphasis', () => {
  it('remove marcador solto após corte', () => {
    expect(balanceWhatsappEmphasis('*negrito')).toBe('negrito');
    expect(balanceWhatsappEmphasis('~risc')).toBe('risc');
    expect(balanceWhatsappEmphasis('texto _ital')).toBe('texto ital');
  });

  it('remove o abridor órfão deixando os pares intactos', () => {
    expect(balanceWhatsappEmphasis('*a* e *b')).toBe('*a* e b');
  });

  it('mantém texto já balanceado', () => {
    expect(balanceWhatsappEmphasis('*a* e _b_ e ~c~')).toBe('*a* e _b_ e ~c~');
  });
});
