import { fetchApi } from '@libs/fetch';
import { Filters } from '@libs/filterInputs';
import { Plugin } from '@typings/plugin';
import { Cheerio, AnyNode, CheerioAPI, load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import dayjs from 'dayjs';

const includesAny = (str: string, keywords: string[]) =>
  new RegExp(keywords.join('|')).test(str);

type MadaraOptions = {
  useNewChapterEndpoint?: boolean;
  lang?: string;
  orderBy?: string;
  versionIncrements?: number;
  customJs?: string;
};

export type MadaraMetadata = {
  id: string;
  sourceSite: string;
  sourceName: string;
  options?: MadaraOptions;
  filters?: any;
};

class MadaraPlugin implements Plugin.PluginBase {
  id: string;
  name: string;
  icon: string;
  site: string;
  version: string;
  options?: MadaraOptions;
  filters?: Filters | undefined;

  constructor(metadata: MadaraMetadata) {
    this.id = metadata.id;
    this.name = metadata.sourceName;
    this.icon = `multisrc/madara/${metadata.id.toLowerCase()}/icon.png`;
    this.site = metadata.sourceSite;
    const versionIncrements = metadata.options?.versionIncrements || 0;
    this.version = `1.0.${5 + versionIncrements}`;
    this.options = metadata.options;
    this.filters = metadata.filters;
  }

  translateDragontea(text: Cheerio<AnyNode>): Cheerio<AnyNode> {
    if (this.id !== 'dragontea') return text;
    
    const $ = parseHTML(text.html()?.replace('\n', '').replace(/<br\s*\/?>/g, '\n') || '');
    const reverseAlpha = 'zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJIHGFEDCBA';
    const forwardAlpha = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    
    text.html($.html());
    text.find('*').addBack().contents().filter((_, el) => el.nodeType === 3).each((_, el) => {
      const $el = $(el);
      const translated = $el.text().normalize('NFD').split('')
        .map(char => {
          const base = char.normalize('NFC');
          const idx = forwardAlpha.indexOf(base);
          return idx >= 0 ? reverseAlpha[idx] + char.slice(base.length) : char;
        })
        .join('');
      $el.replaceWith(translated.replace('\n', '<br>'));
    });
    
    return text;
   }

  getHostname(url: string): string {
    url = url.split('/')[2];
    const url_parts = url.split('.');
    url_parts.pop(); // remove TLD
    return url_parts.join('.');
  }

  async getCheerio(url: string, search: boolean): Promise<CheerioAPI> {
    const r = await fetchApi(url);
    if (!r.ok && search != true)
      throw new Error(
        'Could not reach site (' + r.status + ') try to open in webview.',
      );
    const $ = parseHTML(await r.text());
    const title = $('title').text().trim();
    if (
      this.getHostname(url) != this.getHostname(r.url) ||
      title == 'Bot Verification' ||
      title == 'You are being redirected...' ||
      title == 'Un instant...' ||
      title == 'Just a moment...' ||
      title == 'Redirecting...'
    )
      throw new Error('Captcha error, please open in webview');
    return $;
  }

  parseNovels(loadedCheerio: CheerioAPI): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];

    loadedCheerio('.manga-title-badges').remove();

    loadedCheerio('.page-item-detail, .c-tabs-item__content').each(
      (index, element) => {
        const novelName = loadedCheerio(element)
          .find('.post-title')
          .text()
          .trim();
        const novelUrl =
          loadedCheerio(element).find('.post-title').find('a').attr('href') ||
          '';
        if (!novelName || !novelUrl) return;
        const image = loadedCheerio(element).find('img');
        const novelCover =
          image.attr('data-src') ||
          image.attr('src') ||
          image.attr('data-lazy-srcset') ||
          defaultCover;
        const novel: Plugin.NovelItem = {
          name: novelName,
          cover: novelCover,
          path: novelUrl.replace(/https?:\/\/.*?\//, '/'),
        };
        novels.push(novel);
      },
    );

    return novels;
  }

  async popularNovels(
    pageNo: number,
    {
      filters,
      showLatestNovels,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    let url = this.site + '/page/' + pageNo + '/?s=&post_type=wp-manga';
    if (!filters) filters = this.filters || {};
    if (showLatestNovels) url += '&m_orderby=latest';
    for (const key in filters) {
      if (typeof filters[key].value === 'object')
        for (const value of filters[key].value as string[])
          url += `&${key}=${value}`;
      else if (filters[key].value) url += `&${key}=${filters[key].value}`;
    }
    const loadedCheerio = await this.getCheerio(url, pageNo != 1);
    return this.parseNovels(loadedCheerio);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    let loadedCheerio = await this.getCheerio(this.site + novelPath, false);

    loadedCheerio('.manga-title-badges, #manga-title span').remove();
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name:
        loadedCheerio('.post-title h1').text().trim() ||
        loadedCheerio('#manga-title h1').text().trim(),
    };

    novel.cover =
      loadedCheerio('.summary_image > a > img').attr('data-lazy-src') ||
      loadedCheerio('.summary_image > a > img').attr('data-src') ||
      loadedCheerio('.summary_image > a > img').attr('src') ||
      defaultCover;

    loadedCheerio('.post-content_item, .post-content').each(function () {
      const detailName = loadedCheerio(this).find('h5').text().trim();
      const detail = loadedCheerio(this).find('.summary-content');

      switch (detailName) {
        case 'Genre(s)':
        case 'Genre':
        case 'Tags(s)':
        case 'Tag(s)':
        case 'Tags':
        case 'Género(s)':
        case 'التصنيفات':
          if (novel.genres)
            novel.genres +=
              ', ' +
              detail
                .find('a')
                .map((i, el) => loadedCheerio(el).text())
                .get()
                .join(', ');
          else
            novel.genres = detail
              .find('a')
              .map((i, el) => loadedCheerio(el).text())
              .get()
              .join(', ');
          break;
        case 'Author(s)':
        case 'Author':
        case 'Autor(es)':
        case 'المؤلف':
        case 'المؤلف (ين)':
          novel.author = detail.text().trim();
          break;
        case 'Status':
        case 'Novel':
        case 'Estado':
          novel.status =
            detail.text().trim().includes('OnGoing') ||
            detail.text().trim().includes('مستمرة')
              ? NovelStatus.Ongoing
              : NovelStatus.Completed;
          break;
        case 'Artist(s)':
          novel.artist = detail.text().trim();
          break;
      }
    });

    if (!novel.author)
      novel.author = loadedCheerio('.manga-authors').text().trim();

    loadedCheerio('div.summary__content .code-block,script,noscript').remove();
    novel.summary =
      this.translateDragontea(loadedCheerio('div.summary__content'))
        .text()
        .trim() ||
      loadedCheerio('#tab-manga-about').text().trim() ||
      loadedCheerio('.post-content_item h5:contains("Summary")')
        .next()
        .find('span')
        .map((i, el) => loadedCheerio(el).text())
        .get()
        .join('\n\n')
        .trim() ||
      loadedCheerio('.manga-summary p')
        .map((i, el) => loadedCheerio(el).text())
        .get()
        .join('\n\n')
        .trim() ||
      loadedCheerio('.manga-excerpt p')
        .map((i, el) => loadedCheerio(el).text())
        .get()
        .join('\n\n')
        .trim();
    const chapters: Plugin.ChapterItem[] = [];
    let html = '';

    if (this.options?.useNewChapterEndpoint) {
      html = await fetchApi(this.site + novelPath + 'ajax/chapters/', {
        method: 'POST',
        referrer: this.site + novelPath
      }).then(res => res.text());
    } else {
      const novelId =
        loadedCheerio('.rating-post-id').attr('value') ||
        loadedCheerio('#manga-chapters-holder').attr('data-id') ||
        '';

      const formData = new FormData();
      formData.append('action', 'manga_get_chapters');
      formData.append('manga', novelId);

      html = await fetchApi(this.site + 'wp-admin/admin-ajax.php', {
        method: 'POST',
        body: formData,
      }).then(res => res.text());
    }

    if (html !== '0') {
      loadedCheerio = parseHTML(html);
    }

    const totalChapters = loadedCheerio('.wp-manga-chapter').length;
    loadedCheerio('.wp-manga-chapter').each((chapterIndex, element) => {
      const chapterName = loadedCheerio(element).find('a').text().trim();

      let releaseDate = loadedCheerio(element)
        .find('span.chapter-release-date')
        .text()
        .trim();

      if (releaseDate) {
        releaseDate = this.parseData(releaseDate);
      } else {
        releaseDate = dayjs().format('LL');
      }

      const chapterUrl = loadedCheerio(element).find('a').attr('href') || '';

      if (chapterUrl && chapterUrl != '#') {
        chapters.push({
          name: chapterName,
          path: chapterUrl.replace(/https?:\/\/.*?\//, '/'),
          releaseTime: releaseDate || null,
          chapterNumber: totalChapters - chapterIndex,
        });
      }
    });

    novel.chapters = chapters.reverse();
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const loadedCheerio = await this.getCheerio(this.site + chapterPath, false);
    const chapterText =
      loadedCheerio('.text-left') ||
      loadedCheerio('.text-right') ||
      loadedCheerio('.entry-content') ||
      loadedCheerio('.c-blog-post > div > div:nth-child(2)');

    if (this.options?.customJs) {
      try {
        
      } catch (error) {
        console.error('Error executing customJs:', error);
        throw error;
      }
    }

    return this.translateDragontea(chapterText).html() || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo?: number | undefined,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      this.site +
      '/page/' +
      pageNo +
      '/?s=' +
      searchTerm +
      '&post_type=wp-manga';
    const loadedCheerio = await this.getCheerio(url, true);
    return this.parseNovels(loadedCheerio);
  }

  parseData = (date: string) => {
    let dayJSDate = dayjs(); // today
    const timeAgo = date.match(/\d+/)?.[0] || '';
    const timeAgoInt = parseInt(timeAgo, 10);

    if (!timeAgo) return date; // there is no number!

    if (includesAny(date, ['detik', 'segundo', 'second', 'วินาที'])) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'second'); // go back N seconds
    } else if (
      includesAny(date, [
        'menit',
        'dakika',
        'min',
        'minute',
        'minuto',
        'นาที',
        'دقائق',
      ])
    ) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'minute'); // go back N minute
    } else if (
      includesAny(date, [
        'jam',
        'saat',
        'heure',
        'hora',
        'hour',
        'ชั่วโมง',
        'giờ',
        'ore',
        'ساعة',
        '小时',
      ])
    ) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'hours'); // go back N hours
    } else if (
      includesAny(date, [
        'hari',
        'gün',
        'jour',
        'día',
        'dia',
        'day',
        'วัน',
        'ngày',
        'giorni',
        'أيام',
        '天',
      ])
    ) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'days'); // go back N days
    } else if (includesAny(date, ['week', 'semana'])) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'week'); // go back N a week
    } else if (includesAny(date, ['month', 'mes'])) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'month'); // go back N months
    } else if (includesAny(date, ['year', 'año'])) {
      dayJSDate = dayJSDate.subtract(timeAgoInt, 'year'); // go back N years
    } else {
      if (dayjs(date).format('LL') !== 'Invalid Date') {
        return dayjs(date).format('LL');
      }
      return date;
    }

    return dayJSDate.format('LL');
  };
}

const plugin = new MadaraPlugin({"id":"fortuneeternal","sourceSite":"https://fortuneeternal.com","sourceName":"Fortune Eternal","options":{"lang":"Korean","useNewChapterEndpoint":true,"versionIncrements":1},"filters":{"genre[]":{"type":"Checkbox","label":"Genre","value":[],"options":[{"label":"Abandoned Children","value":"abandoned-children"},{"label":"Academy","value":"academy"},{"label":"Action","value":"action"},{"label":"Adopted Protagonist","value":"adopted-protagonist"},{"label":"Adult","value":"adult"},{"label":"Adventure","value":"adventure"},{"label":"Age progression","value":"age-progression"},{"label":"Alternate World","value":"alternate-world"},{"label":"Animated","value":"animated"},{"label":"Anime","value":"anime"},{"label":"Apocalypse","value":"apocalypse"},{"label":"Aristocracy","value":"aristocracy"},{"label":"Arts","value":"arts"},{"label":"Award Winning","value":"award-winning"},{"label":"Betrayal","value":"betrayal"},{"label":"Body Swap","value":"body-swap"},{"label":"Business","value":"business"},{"label":"Card Game","value":"card-game"},{"label":"Cartoon","value":"cartoon"},{"label":"Chaebol","value":"chaebol"},{"label":"Cheat","value":"cheat"},{"label":"Childcare","value":"childcare"},{"label":"Chinese","value":"chinese"},{"label":"Civilization","value":"civilization"},{"label":"Clan Building","value":"clan-building-2"},{"label":"Clan Building]","value":"clan-building"},{"label":"Clever protagonist","value":"clever-protagonist"},{"label":"Comedy","value":"comedy"},{"label":"Comic","value":"comic"},{"label":"Cooking","value":"cooking"},{"label":"Dark","value":"dark"},{"label":"Detective","value":"detective"},{"label":"Disabilities","value":"disabilities"},{"label":"Doujinshi","value":"doujinshi"},{"label":"Drama","value":"drama"},{"label":"Dying","value":"dying"},{"label":"Eastern Fantasy","value":"eastern-fantasy"},{"label":"Ecchi","value":"ecchi"},{"label":"Evil organization","value":"evil-organization"},{"label":"evil protagonist","value":"evil-protagonist"},{"label":"Exorcism","value":"exorcism"},{"label":"Extra character","value":"extra-character"},{"label":"Fanfiction","value":"fanfiction"},{"label":"Fantasy","value":"fantasy"},{"label":"Farming","value":"farming"},{"label":"Fashion","value":"fashion"},{"label":"Female MC","value":"female-mc"},{"label":"Firearms","value":"firearms"},{"label":"Futuristic","value":"futuristic"},{"label":"Game","value":"game"},{"label":"Game character","value":"game-character"},{"label":"Game element","value":"game-element"},{"label":"Gate to another world","value":"gate-to-another-world"},{"label":"Gender Bender","value":"gender-bender"},{"label":"Genius","value":"genius"},{"label":"Ghost posessed","value":"ghost-posessed"},{"label":"Harem","value":"harem"},{"label":"Healthcare","value":"healthcare"},{"label":"Historical","value":"historical"},{"label":"Horror","value":"horror"},{"label":"human to animal","value":"human-to-animal"},{"label":"Japanese","value":"japanese"},{"label":"Josei","value":"josei"},{"label":"Judicial","value":"judicial"},{"label":"Korean","value":"korean"},{"label":"Level system","value":"level-system"},{"label":"Live action","value":"live-action"},{"label":"Manga","value":"manga"},{"label":"Manhua","value":"manhua"},{"label":"Manhwa","value":"manhwa"},{"label":"Married life","value":"married-life"},{"label":"Martial Arts","value":"martial-arts"},{"label":"Mature","value":"mature"},{"label":"Mecha","value":"mecha"},{"label":"Medical","value":"medical"},{"label":"Military","value":"military"},{"label":"misunderstanding","value":"misunderstanding"},{"label":"Modern","value":"modern"},{"label":"Monster Life","value":"monster-life"},{"label":"Monster tamer","value":"monster-tamer"},{"label":"MTL","value":"mtl"},{"label":"Music","value":"music"},{"label":"Mystery","value":"mystery"},{"label":"Novel Character","value":"novel-character"},{"label":"One shot","value":"one-shot"},{"label":"Original","value":"original"},{"label":"Outer Space","value":"outer-space"},{"label":"Overpowered","value":"overpowered"},{"label":"Political","value":"political"},{"label":"Polygamy","value":"polygamy"},{"label":"Possesion","value":"possesion"},{"label":"Post-Apocalypse","value":"post-apocalypse"},{"label":"Premium","value":"premium"},{"label":"Psychological","value":"psychological"},{"label":"RAW","value":"raw"},{"label":"Regression","value":"regression"},{"label":"Reincarnation","value":"reincarnation"},{"label":"Request","value":"request"},{"label":"Returnee","value":"returnee"},{"label":"Revenge","value":"revenge"},{"label":"Reverse Harem","value":"reverse-harem"},{"label":"Romance","value":"romance"},{"label":"Romance Fantasy","value":"romance-fantasy"},{"label":"Royal family","value":"royal-family"},{"label":"School Life","value":"school-life"},{"label":"Sci-fi","value":"sci-fi"},{"label":"Science Fiction","value":"science-fiction"},{"label":"Seinen","value":"seinen"},{"label":"Shoujo","value":"shoujo"},{"label":"Shoujo Ai","value":"shoujo-ai"},{"label":"Shounen","value":"shounen"},{"label":"Shounen Ai","value":"shounen-ai"},{"label":"Showbiz","value":"showbiz"},{"label":"Slice of Life","value":"slice-of-life"},{"label":"Smut","value":"smut"},{"label":"Soft Yaoi","value":"soft-yaoi"},{"label":"Soft Yuri","value":"soft-yuri"},{"label":"Sports","value":"sports"},{"label":"Strong to stronger","value":"strong-to-stronger"},{"label":"Sudden Rich","value":"sudden-rich"},{"label":"Superhero theme","value":"superhero-theme"},{"label":"Supernatural","value":"supernatural"},{"label":"Survival","value":"survival"},{"label":"System","value":"system"},{"label":"Teacher Protagonist","value":"teacher-protagonist"},{"label":"Time","value":"time"},{"label":"Tragedy","value":"tragedy"},{"label":"Tragic past","value":"tragic-past"},{"label":"Transmigration","value":"transmigration"},{"label":"Tycoon","value":"tycoon"},{"label":"Villain","value":"villain"},{"label":"Warring period","value":"warring-period"},{"label":"Weak to Strong","value":"weak-to-strong"},{"label":"Webtoon","value":"webtoon"},{"label":"World Hopping","value":"world-hopping"},{"label":"Writer","value":"writer"},{"label":"Yandere","value":"yandere"},{"label":"Yaoi","value":"yaoi"},{"label":"Yuri","value":"yuri"}]},"op":{"type":"Switch","label":"having all selected genres","value":false},"author":{"type":"Text","label":"Author","value":""},"artist":{"type":"Text","label":"Artist","value":""},"release":{"type":"Text","label":"Year of Released","value":""},"adult":{"type":"Picker","label":"Adult content","value":"","options":[{"label":"All","value":""},{"label":"None adult content","value":"0"},{"label":"Only adult content","value":"1"}]},"status[]":{"type":"Checkbox","label":"Status","value":[],"options":[{"label":"OnGoing","value":"on-going"},{"label":"Completed","value":"end"},{"label":"Canceled","value":"canceled"},{"label":"On Hold","value":"on-hold"},{"label":"Upcoming","value":"upcoming"}]},"m_orderby":{"type":"Picker","label":"Order by","value":"","options":[{"label":"Relevance","value":""},{"label":"Latest","value":"latest"},{"label":"A-Z","value":"alphabet"},{"label":"Rating","value":"rating"},{"label":"Trending","value":"trending"},{"label":"Most Views","value":"views"},{"label":"New","value":"new-manga"}]}}});
export default plugin;