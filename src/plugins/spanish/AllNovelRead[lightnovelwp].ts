import { load } from 'cheerio';
import { Parser } from 'htmlparser2';
import { fetchApi } from '@libs/fetch';
import { Plugin } from '@typings/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';
import { Filters } from '@libs/filterInputs';

type LightNovelWPOptions = {
  reverseChapters?: boolean;
  lang?: string;
  versionIncrements?: number;
  seriesPath?: string;
  customJs?: string;
};

export type LightNovelWPMetadata = {
  id: string;
  sourceSite: string;
  sourceName: string;
  options?: LightNovelWPOptions;
  filters?: any;
};

class LightNovelWPPlugin implements Plugin.PluginBase {
  id: string;
  name: string;
  icon: string;
  site: string;
  version: string;
  options?: LightNovelWPOptions;
  filters?: Filters;

  constructor(metadata: LightNovelWPMetadata) {
    this.id = metadata.id;
    this.name = metadata.sourceName;
    this.icon = `multisrc/lightnovelwp/${metadata.id.toLowerCase()}/icon.png`;
    this.site = metadata.sourceSite;
    const versionIncrements = metadata.options?.versionIncrements || 0;
    this.version = `1.1.${4 + versionIncrements}`;
    this.options = metadata.options ?? ({} as LightNovelWPOptions);
    this.filters = metadata.filters satisfies Filters;
  }

  getHostname(url: string): string {
    url = url.split('/')[2];
    const url_parts = url.split('.');
    url_parts.pop(); // remove TLD
    return url_parts.join('.');
  }

  async safeFecth(url: string, search: boolean): Promise<string> {
    const r = await fetchApi(url);
    if (!r.ok && search != true)
      throw new Error(
        'Could not reach site (' + r.status + ') try to open in webview.',
      );
    const data = await r.text();
    const title = data.match(/<title>(.*?)<\/title>/)?.[1]?.trim();

    if (
      this.getHostname(url) != this.getHostname(r.url) ||
      (title &&
        (title == 'Bot Verification' ||
          title == 'You are being redirected...' ||
          title == 'Un instant...' ||
          title == 'Just a moment...' ||
          title == 'Redirecting...'))
    )
      throw new Error('Captcha error, please open in webview');

    return data;
  }

  parseNovels(html: string): Plugin.NovelItem[] {
    html = load(html).html(); // fix "'" beeing replaced by "&#8217;" (html entities)
    const novels: Plugin.NovelItem[] = [];

    const articles = html.match(/<article([\s\S]*?)<\/article>/g) || [];
    articles.forEach(article => {
      const [, novelUrl, novelName] =
        article.match(/<a href="(.*?)".*title="(.*?)"/) || [];

      if (novelName && novelUrl) {
        const novelCover =
          article.match(/<img.*src="(.*?)"(?:\sdata-src="(.*?)")?.*\/?>/) || [];

        novels.push({
          name: novelName,
          cover: novelCover[2] || novelCover[1] || defaultCover,
          path: novelUrl.replace(this.site, ''),
        });
      }
    });

    return novels;
  }

  async popularNovels(
    pageNo: number,
    {
      filters,
      showLatestNovels,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const seriesPath = this.options?.seriesPath ?? 'series/';
    let url = this.site + seriesPath + '?page=' + pageNo;
    if (!filters) filters = this.filters || {};
    if (showLatestNovels) url += '&order=latest';
    for (const key in filters) {
      if (typeof filters[key].value === 'object')
        for (const value of filters[key].value as string[])
          url += `&${key}=${value}`;
      else if (filters[key].value) url += `&${key}=${filters[key].value}`;
    }
    const html = await this.safeFecth(url, false);
    return this.parseNovels(html);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const baseURL = this.site;
    const html = await this.safeFecth(baseURL + novelPath, false);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: '',
      genres: '',
      summary: '',
      author: '',
      artist: '',
      status: '',
      chapters: [] as Plugin.ChapterItem[],
    };
    let isParsingGenres = false;
    let isReadingGenre = false;
    let isReadingSummary = false;
    let isParsingInfo = false;
    let isReadingInfo = false;
    let isReadingAuthor = false;
    let isReadingArtist = false;
    let isReadingStatus = false;
    let isParsingChapterList = false;
    let isReadingChapter = false;
    let isReadingChapterInfo = 0;
    let isPaidChapter = false;
    const chapters: Plugin.ChapterItem[] = [];
    let tempChapter = {} as Plugin.ChapterItem;

    const parser = new Parser({
      onopentag(name, attribs) {
        // name and cover
        if (!novel.cover && attribs['class']?.includes('ts-post-image')) {
          novel.name = attribs['title'];
          novel.cover = attribs['data-src'] || attribs['src'] || defaultCover;
        } // genres
        else if (
          attribs['class'] === 'genxed' ||
          attribs['class'] === 'sertogenre'
        ) {
          isParsingGenres = true;
        } else if (isParsingGenres && name === 'a') {
          isReadingGenre = true;
        } // summary
        else if (
          name === 'div' &&
          (attribs['class'] === 'entry-content' ||
            attribs['itemprop'] === 'description')
        ) {
          isReadingSummary = true;
        } // author and status
        else if (attribs['class'] === 'spe' || attribs['class'] === 'serl') {
          isParsingInfo = true;
        } else if (isParsingInfo && name === 'span') {
          isReadingInfo = true;
        } else if (name === 'div' && attribs['class'] === 'sertostat') {
          isParsingInfo = true;
          isReadingInfo = true;
          isReadingStatus = true;
        }
        // chapters
        else if (attribs['class'] && attribs['class'].includes('eplister')) {
          isParsingChapterList = true;
        } else if (isParsingChapterList && name === 'li') {
          isReadingChapter = true;
        } else if (isReadingChapter) {
          if (name === 'a' && tempChapter.path === undefined) {
            tempChapter.path = attribs['href'].replace(baseURL, '').trim();
          } else if (attribs['class'] === 'epl-num') {
            isReadingChapterInfo = 1;
          } else if (attribs['class'] === 'epl-title') {
            isReadingChapterInfo = 2;
          } else if (attribs['class'] === 'epl-date') {
            isReadingChapterInfo = 3;
          } else if (attribs['class'] === 'epl-price') {
            isReadingChapterInfo = 4;
          }
        }
      },
      ontext(data) {
        // genres
        if (isParsingGenres) {
          if (isReadingGenre) {
            novel.genres += data + ', ';
          }
        } // summary
        else if (isReadingSummary) {
          novel.summary += data.trim();
        } // author and status
        else if (isParsingInfo) {
          if (isReadingInfo) {
            const detailName = data.toLowerCase().replace(':', '').trim();

            if (isReadingAuthor) {
              novel.author += data || 'Unknown';
            } else if (isReadingArtist) {
              novel.artist += data || 'Unknown';
            } else if (isReadingStatus) {
              switch (detailName) {
                case 'مكتملة':
                case 'completed':
                case 'complété':
                case 'completo':
                case 'completado':
                case 'tamamlandı':
                  novel.status = NovelStatus.Completed;
                  break;
                case 'مستمرة':
                case 'ongoing':
                case 'en cours':
                case 'em andamento':
                case 'en progreso':
                case 'devam ediyor':
                  novel.status = NovelStatus.Ongoing;
                  break;
                case 'متوقفة':
                case 'hiatus':
                case 'en pause':
                case 'hiato':
                case 'pausa':
                case 'pausado':
                case 'duraklatıldı':
                  novel.status = NovelStatus.OnHiatus;
                  break;
                default:
                  novel.status = NovelStatus.Unknown;
                  break;
              }
            }

            switch (detailName) {
              case 'الكاتب':
              case 'author':
              case 'auteur':
              case 'autor':
              case 'yazar':
                isReadingAuthor = true;
                break;
              case 'الحالة':
              case 'status':
              case 'statut':
              case 'estado':
              case 'durum':
                isReadingStatus = true;
                break;
              case 'الفنان':
              case 'artist':
              case 'artiste':
              case 'artista':
              case 'çizer':
                isReadingArtist = true;
                break;
            }
          }
        } // chapters
        else if (isParsingChapterList) {
          if (isReadingChapter) {
            if (isReadingChapterInfo === 1) {
              extractChapterNumber(data, tempChapter);
            } else if (isReadingChapterInfo === 2) {
              tempChapter.name =
                data
                  .match(
                    RegExp(
                      `^${novel.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(.+)`,
                    ),
                  )?.[1]
                  ?.trim() || data.trim();
              if (!tempChapter.chapterNumber) {
                extractChapterNumber(data, tempChapter);
              }
            } else if (isReadingChapterInfo === 3) {
              tempChapter.releaseTime = data; //new Date(data).toISOString();
            } else if (isReadingChapterInfo === 4) {
              const detailName = data.toLowerCase().trim();
              switch (detailName) {
                case 'free':
                case 'gratuit':
                case 'مجاني':
                case 'livre':
                case '':
                  isPaidChapter = false;
                  break;
                default:
                  isPaidChapter = true;
                  break;
              }
            }
          }
        }
      },
      onclosetag(name) {
        // genres
        if (isParsingGenres) {
          if (isReadingGenre) {
            isReadingGenre = false; // stop reading genre
          } else {
            isParsingGenres = false; // stop parsing genres
            novel.genres = novel.genres?.slice(0, -2); // remove trailing comma
          }
        } // summary
        else if (isReadingSummary) {
          if (name === 'br') {
            novel.summary += '\n';
          } else if (name === 'div') {
            isReadingSummary = false;
          }
        } // author and status
        else if (isParsingInfo) {
          if (isReadingInfo) {
            if (name === 'span') {
              isReadingInfo = false;
              if (isReadingAuthor && novel.author) {
                isReadingAuthor = false;
              } else if (isReadingArtist && novel.artist) {
                isReadingArtist = false;
              } else if (isReadingStatus && novel.status !== '') {
                isReadingStatus = false;
              }
            }
          } else if (name === 'div') {
            isParsingInfo = false;
            novel.author = novel.author?.trim();
            novel.artist = novel.artist?.trim();
          }
        } // chapters
        else if (isParsingChapterList) {
          if (isReadingChapter) {
            if (isReadingChapterInfo === 1) {
              isReadingChapterInfo = 0;
            } else if (isReadingChapterInfo === 2) {
              isReadingChapterInfo = 0;
            } else if (isReadingChapterInfo === 3) {
              isReadingChapterInfo = 0;
            } else if (isReadingChapterInfo === 4) {
              isReadingChapterInfo = 0;
            } else if (name === 'li') {
              isReadingChapter = false;
              if (!tempChapter.chapterNumber) tempChapter.chapterNumber = 0;
              if (!isPaidChapter) chapters.push(tempChapter);
              tempChapter = {} as Plugin.ChapterItem;
            }
          } else if (name === 'ul') {
            isParsingChapterList = false;
          }
        }
      },
    });

    parser.write(html);
    parser.end();

    if (chapters.length) {
      if (this.options?.reverseChapters) chapters.reverse();
      novel.chapters = chapters;
    }

    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    let data = await this.safeFecth(this.site + chapterPath, false);
    if (this.options?.customJs) {
      try {
        const $ = load(data);
        
        data = $.html();
      } catch (error) {
        console.error('Error executing customJs:', error);
        throw error;
      }
    }
    return (
      data
        .match(/<div.*class="epcontent ([\s\S]*?)<div.*class="bottomnav"/g)?.[0]
        .match(/<p.*>([\s\S]*?)<\/p>/g)
        ?.join('\n') || ''
    );
  }

  async searchNovels(
    searchTerm: string,
    page: number,
  ): Promise<Plugin.NovelItem[]> {
    const url = this.site + 'page/' + page + '/?s=' + searchTerm;
    const html = await this.safeFecth(url, true);
    return this.parseNovels(html);
  }
}

function extractChapterNumber(data: string, tempChapter: Plugin.ChapterItem) {
  const tempChapterNumber = data.match(/(\d+)$/);
  if (tempChapterNumber && tempChapterNumber[0]) {
    tempChapter.chapterNumber = parseInt(tempChapterNumber[0]);
  }
}

const plugin = new LightNovelWPPlugin({"id":"allnovelread","sourceSite":"https://allnovelread.com/","sourceName":"AllNovelRead","options":{"lang":"Spanish","reverseChapters":true},"filters":{"genre[]":{"type":"Checkbox","label":"Genre","value":[],"options":[{"label":"16+","value":"16"},{"label":"Abogado/Abogada","value":"abogado-abogada"},{"label":"Action","value":"action"},{"label":"Advogdo","value":"advogdo"},{"label":"affair of the heart","value":"affair-of-the-heart"},{"label":"alfa","value":"alfa"},{"label":"Alpha","value":"alpha"},{"label":"Amable","value":"amable"},{"label":"Amar","value":"amar"},{"label":"Amor","value":"amor"},{"label":"Amor caliente","value":"amor-caliente"},{"label":"amor depois do casamento","value":"amor-depois-do-casamento"},{"label":"Amor después del matrimonio","value":"amor-despues-del-matrimonio"},{"label":"Amor destinado","value":"amor-destinado"},{"label":"Amor doloroso","value":"amor-doloroso"},{"label":"Amor dulce","value":"amor-dulce"},{"label":"Amor e ódio","value":"amor-e-odio"},{"label":"Amor e ódio Gravidez","value":"amor-e-odio-gravidez"},{"label":"amor entre ex","value":"amor-entre-ex"},{"label":"Amor forzado","value":"amor-forzado"},{"label":"Amor Inocente","value":"amor-inocente"},{"label":"amor predestinado","value":"amor-predestinado"},{"label":"Amor y odio","value":"amor-y-odio"},{"label":"arrepentirse del divorcio","value":"arrepentirse-del-divorcio"},{"label":"Arrepentirse Después de Herir a Su Mujer","value":"arrepentirse-despues-de-herir-a-su-mujer"},{"label":"Arrogante","value":"arrogante"},{"label":"Asesinato","value":"asesinato"},{"label":"Babby","value":"babby"},{"label":"BABY","value":"baby"},{"label":"Beauty","value":"beauty"},{"label":"Bebê fofo","value":"bebe-fofo"},{"label":"Bebé inteligente","value":"bebe-inteligente"},{"label":"belleza","value":"belleza"},{"label":"Belleza inusual","value":"belleza-inusual"},{"label":"Bilionário","value":"bilionario"},{"label":"Billionair","value":"billionair"},{"label":"billionaire","value":"billionaire"},{"label":"Billonario/Billonaria","value":"billonario-billonaria"},{"label":"brilliant","value":"brilliant"},{"label":"bxg","value":"bxg"},{"label":"Bxg-novela","value":"bxg-novela"},{"label":"Campus","value":"campus"},{"label":"Casamiento","value":"casamiento"},{"label":"CEO","value":"ceo"},{"label":"city","value":"city"},{"label":"Colegiala","value":"colegiala"},{"label":"Comedia","value":"comedia"},{"label":"Comedia-novela","value":"comedia-novela"},{"label":"Comedy","value":"comedy"},{"label":"contemporáneo","value":"contemporaneo"},{"label":"Contract marriage","value":"contract-marriage"},{"label":"cónyuge","value":"conyuge"},{"label":"Corazón roto","value":"corazon-roto"},{"label":"courtship","value":"courtship"},{"label":"Crecimiento del personaje","value":"crecimiento-del-personaje"},{"label":"Crimen organizado","value":"crimen-organizado"},{"label":"Critical","value":"critical"},{"label":"cruel","value":"cruel"},{"label":"De pobre a rico","value":"de-pobre-a-rico"},{"label":"Divertido","value":"divertido"},{"label":"Divorce","value":"divorce"},{"label":"Divorcio","value":"divorcio"},{"label":"Doce","value":"doce"},{"label":"Doctor","value":"doctor"},{"label":"Dominador","value":"dominador"},{"label":"Dominante","value":"dominante"},{"label":"Dominante-novela","value":"dominante-novela"},{"label":"drama","value":"drama"},{"label":"dulce","value":"dulce"},{"label":"Dulce Embarazada","value":"dulce-embarazada"},{"label":"elegante","value":"elegante"},{"label":"Embarazada","value":"embarazada"},{"label":"En la actualidad","value":"en-la-actualidad"},{"label":"Enemigos a los amantes","value":"enemigos-a-los-amantes"},{"label":"existente","value":"existente"},{"label":"Family","value":"family"},{"label":"Fantasy","value":"fantasy"},{"label":"Fated","value":"fated"},{"label":"Fraco para forte/Pob","value":"fraco-para-forte-pob"},{"label":"fuerte","value":"fuerte"},{"label":"Goodgirl","value":"goodgirl"},{"label":"Gravidez","value":"gravidez"},{"label":"HE","value":"he"},{"label":"heir/heiress","value":"heir-heiress"},{"label":"hermoso","value":"hermoso"},{"label":"Héroe pateador","value":"heroe-pateador"},{"label":"Heroina","value":"heroina"},{"label":"heroína Kickass","value":"heroina-kickass"},{"label":"heterose*ual","value":"heteroseual"},{"label":"historia de amor","value":"historia-de-amor"},{"label":"Hot Romance","value":"hot-romance"},{"label":"Humor","value":"humor"},{"label":"Identidad secreta","value":"identidad-secreta"},{"label":"Independente","value":"independente"},{"label":"Independiente","value":"independiente"},{"label":"Inocente","value":"inocente"},{"label":"jefe","value":"jefe"},{"label":"Jefe / CEO","value":"jefe-ceo"},{"label":"kicking","value":"kicking"},{"label":"king","value":"king"},{"label":"legend","value":"legend"},{"label":"Literature","value":"literature"},{"label":"loser","value":"loser"},{"label":"Love","value":"love"},{"label":"Love & Culture","value":"love-culture"},{"label":"love after marriage","value":"love-after-marriage"},{"label":"love story","value":"love-story"},{"label":"LOVEAFTERMARRIAGE","value":"loveaftermarriage"},{"label":"lucky dog","value":"lucky-dog"},{"label":"Lugar para você Allnovelread","value":"lugar-para-voce-allnovelread"},{"label":"luna","value":"luna"},{"label":"Madre soltera","value":"madre-soltera"},{"label":"Mafia","value":"mafia"},{"label":"magical world","value":"magical-world"},{"label":"Malentendido","value":"malentendido"},{"label":"Maquinación","value":"maquinacion"},{"label":"Marriage","value":"marriage"},{"label":"Matrimonio","value":"matrimonio"},{"label":"Matrimonio por Contrato","value":"matrimonio-por-contrato"},{"label":"Matrimonio relámpago","value":"matrimonio-relampago"},{"label":"Medico","value":"medico"},{"label":"Médico/Médica","value":"medico-medica"},{"label":"millonaria","value":"millonaria"},{"label":"modificación","value":"modificacion"},{"label":"most millions","value":"most-millions"},{"label":"Mucama","value":"mucama"},{"label":"Mujer súper poderosa","value":"mujer-super-poderosa"},{"label":"Multi-Millionairo","value":"multi-millionairo"},{"label":"Multimillionairo","value":"multimillionairo"},{"label":"Multimillonaria","value":"multimillonaria"},{"label":"multimillonario","value":"multimillonario"},{"label":"Multimillonario-novela","value":"multimillonario-novela"},{"label":"MULTIPLEIDENTITIES","value":"multipleidentities"},{"label":"Múltiples identidades","value":"multiples-identidades"},{"label":"musculoso","value":"musculoso"},{"label":"Nacimiento múltiple","value":"nacimiento-multiple"},{"label":"Novia embarazada a la fuga","value":"novia-embarazada-a-la-fuga"},{"label":"Obsesión","value":"obsesion"},{"label":"Ocultar","value":"ocultar"},{"label":"Optimista","value":"optimista"},{"label":"others","value":"others"},{"label":"Pasión de una noche","value":"pasion-de-una-noche"},{"label":"Perao/Segunda chance","value":"perao-segunda-chance"},{"label":"Perdedor","value":"perdedor"},{"label":"Playboy","value":"playboy"},{"label":"poderoso","value":"poderoso"},{"label":"polygamy","value":"polygamy"},{"label":"Posesivo","value":"posesivo"},{"label":"possessive","value":"possessive"},{"label":"Possessivo","value":"possessivo"},{"label":"Powerful","value":"powerful"},{"label":"presente","value":"presente"},{"label":"Presidente","value":"presidente"},{"label":"princess","value":"princess"},{"label":"Protective","value":"protective"},{"label":"Protectormadre soltera","value":"protectormadre-soltera"},{"label":"Reconquistar a mi pareja","value":"reconquistar-a-mi-pareja"},{"label":"rejected","value":"rejected"},{"label":"relación","value":"relacion"},{"label":"relationship","value":"relationship"},{"label":"Renacido","value":"renacido"},{"label":"Rey/Reina","value":"rey-reina"},{"label":"Rich","value":"rich"},{"label":"Rico","value":"rico"},{"label":"Ricos","value":"ricos"},{"label":"Romance","value":"romance"},{"label":"romance caliente","value":"romance-caliente"},{"label":"Romance/Romântico","value":"romance-romantico"},{"label":"Romántic","value":"romantic"},{"label":"Romantica","value":"romantica"},{"label":"Romanticas","value":"romanticas"},{"label":"Romantico","value":"romantico"},{"label":"Secretos","value":"secretos"},{"label":"secrets","value":"secrets"},{"label":"seductive","value":"seductive"},{"label":"Segunda Chance","value":"segunda-chance"},{"label":"Segunda oportunidad","value":"segunda-oportunidad"},{"label":"STRONGFEMALELEAD","value":"strongfemalelead"},{"label":"Subrogación","value":"subrogacion"},{"label":"Suspense","value":"suspense"},{"label":"Sweet","value":"sweet"},{"label":"SWEETLOVE","value":"sweetlove"},{"label":"Teenager","value":"teenager"},{"label":"Tierno","value":"tierno"},{"label":"Tragedia","value":"tragedia"},{"label":"Traición","value":"traicion"},{"label":"TraiciónReconquistar a mi pareja","value":"traicionreconquistar-a-mi-pareja"},{"label":"Triángulo amoroso","value":"triangulo-amoroso"},{"label":"Trillizos","value":"trillizos"},{"label":"Trio","value":"trio"},{"label":"Una noche de pasion","value":"una-noche-de-pasion"},{"label":"Universidad","value":"universidad"},{"label":"Valente","value":"valente"},{"label":"Valiente","value":"valiente"},{"label":"Venanza","value":"venanza"},{"label":"Werewolf","value":"werewolf"},{"label":"Ya","value":"ya"},{"label":"Youth","value":"youth"}]},"type[]":{"type":"Checkbox","label":"Type","value":[],"options":[{"label":"16+","value":"16"},{"label":"alfa","value":"alfa"},{"label":"Allnovelread Sin vuelta atrás","value":"allnovelread-sin-vuelta-atras"},{"label":"Alpha","value":"alpha"},{"label":"Amor dulce","value":"amor-dulce"},{"label":"Amor y odio","value":"amor-y-odio"},{"label":"Arrogante-novela","value":"arrogante-novela"},{"label":"Billionaire","value":"billionaire"},{"label":"Billonario","value":"billonario"},{"label":"bxg","value":"bxg"},{"label":"CEO","value":"ceo"},{"label":"Contemporâneo","value":"contemporaneo"},{"label":"Contract marriage","value":"contract-marriage"},{"label":"crecimiento-del-personaje-novela","value":"crecimiento-del-personaje-novela"},{"label":"Divorce","value":"divorce"},{"label":"drama","value":"drama"},{"label":"dulce","value":"dulce"},{"label":"El incesante acoso de mi ex marido","value":"el-incesante-acoso-de-mi-ex-marido"},{"label":"Enganar al mejor amigo de mi novio","value":"enganar-al-mejor-amigo-de-mi-novio"},{"label":"Fantasy","value":"fantasy"},{"label":"HE","value":"he"},{"label":"heterosexual","value":"heterosexual"},{"label":"Historia-triste-novela","value":"historia-triste-novela"},{"label":"Hombre lobo","value":"hombre-lobo"},{"label":"Hot Romance","value":"hot-romance"},{"label":"Independiente","value":"independiente"},{"label":"Inocente","value":"inocente"},{"label":"king","value":"king"},{"label":"Love","value":"love"},{"label":"love after marriage","value":"love-after-marriage"},{"label":"Luna","value":"luna"},{"label":"Magical world","value":"magical-world"},{"label":"millonaria","value":"millonaria"},{"label":"Multi-Millionaire","value":"multi-millionaire"},{"label":"Multimillionairo","value":"multimillionairo"},{"label":"Multimillonario","value":"multimillonario"},{"label":"Nunca Longe Allnovelread","value":"nunca-longe-allnovelread"},{"label":"Posesivo","value":"posesivo"},{"label":"Querida ex esposa","value":"querida-ex-esposa"},{"label":"Romance","value":"romance"},{"label":"Romane","value":"romane"},{"label":"Romántica","value":"romantica"},{"label":"Romanticas","value":"romanticas"},{"label":"Romantico","value":"romantico"},{"label":"Sweet","value":"sweet"},{"label":"SWEETLOVE","value":"sweetlove"},{"label":"Te Quero de Volta Allnovelread","value":"te-quero-de-volta-allnovelread"},{"label":"Traicion en altar","value":"traicion-en-altar"},{"label":"Uma Ferida Que Nunca Se Cura Allnovelread","value":"uma-ferida-que-nunca-se-cura-allnovelread"},{"label":"Urban","value":"urban"},{"label":"Urban/Realistic","value":"urban-realistic"},{"label":"vuelva a mí","value":"vuelva-a-mi"},{"label":"Werewolf","value":"werewolf"}]},"status":{"type":"Picker","label":"Status","value":"","options":[{"label":"All","value":""},{"label":"Ongoing","value":"ongoing"},{"label":"Hiatus","value":"hiatus"},{"label":"Completed","value":"completed"}]},"order":{"type":"Picker","label":"Order by","value":"","options":[{"label":"Default","value":""},{"label":"A-Z","value":"title"},{"label":"Z-A","value":"titlereverse"},{"label":"Latest Update","value":"update"},{"label":"Latest Added","value":"latest"},{"label":"Popular","value":"popular"}]}}});
export default plugin;